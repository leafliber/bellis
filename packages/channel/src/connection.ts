import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import {
  ChannelAccept,
  ChannelChallenge,
  ChannelHello,
  ChannelProof,
  ChannelRole,
} from '@bellis/protocol';
import { Compile } from 'typebox/compile';
import { SESSION_KEY_BYTES } from './address.ts';
import { ChannelError } from './errors.ts';
import { encodeFrame, type Frame, FrameDecoder, FrameKind } from './frame.ts';

export interface ConnectionOptions {
  /** 本次会话的共享密钥（R-05）。 */
  key: Uint8Array;
  /** 握手须在此时限内完成，默认 2000ms。 */
  handshakeTimeoutMs?: number;
  /** 认证后单帧负载的上限，默认 1 MiB。 */
  maxFrameBytes?: number;
}

export type ConnectionEvents = {
  message: [message: unknown];
  binary: [data: Buffer];
  /** 连接关闭；正常关闭时 error 为 undefined。只触发一次。 */
  close: [error: ChannelError | undefined];
};

/** 认证前单帧上限：握手消息都很小，避免未认证的对端占用内存。 */
const HANDSHAKE_MAX_FRAME_BYTES = 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 2000;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const CLOSE_GRACE_MS = 1000;
const PROOF_DOMAIN = 'bellis-channel/1';

const isHello = Compile(ChannelHello);
const isChallenge = Compile(ChannelChallenge);
const isProof = Compile(ChannelProof);
const isAccept = Compile(ChannelAccept);
const isRole = Compile(ChannelRole);

type Step =
  | { name: 'await-hello' }
  | { name: 'await-challenge'; role: string; clientNonce: string }
  | { name: 'await-proof'; role: string; clientNonce: string; serverNonce: string }
  | { name: 'await-accept'; role: string }
  | { name: 'open' }
  | { name: 'closed' };

type MacArgs = [
  direction: 'server' | 'client',
  role: string,
  clientNonce: string,
  serverNonce: string,
];

function randomNonce(): string {
  return randomBytes(32).toString('base64url');
}

/** 会话密钥必须是完整的 32 字节随机数（R-05）。 */
export function checkSessionKey(key: Uint8Array): void {
  if (key.byteLength !== SESSION_KEY_BYTES) {
    throw new ChannelError('invalid-key', `会话密钥须为 ${SESSION_KEY_BYTES} 字节`);
  }
}

function asChannelError(error: unknown): ChannelError {
  if (error instanceof ChannelError) return error;
  return new ChannelError('protocol-error', String(error), { cause: error });
}

/**
 * 一条已认证的本机连接。由 `listen` / `connect` 在握手成功后交出。
 *
 * 握手（R-05）：客户端发 hello（角色 + 随机数）；服务端回 challenge（随机数 + 证明）；
 * 客户端核验服务端证明后才回送自己的证明；服务端核验后回 accept。
 * 证明为 HMAC-SHA256(会话密钥, [域, 方向, 角色, 客户端随机数, 服务端随机数])。
 * 认证完成前收到任何业务帧都会断开连接。
 *
 * 收到连接对象后，须在同一个同步段内挂上 `message` / `binary` 监听器；
 * 握手后紧跟到达的帧会在下一轮事件循环才分发。
 */
export class Connection extends EventEmitter<ConnectionEvents> {
  readonly #socket: Socket;
  readonly #key: Uint8Array;
  readonly #maxFrameBytes: number;
  readonly #decoder = new FrameDecoder(HANDSHAKE_MAX_FRAME_BYTES);
  readonly #ready = Promise.withResolvers<Connection>();
  #step: Step;
  #role = '';
  #gated = false;
  #error: ChannelError | undefined;
  #closeEmitted = false;
  #handshakeTimer: NodeJS.Timeout | undefined;
  #closeTimer: NodeJS.Timeout | undefined;

  /** 服务端：等待客户端完成握手。 */
  static accept(socket: Socket, options: ConnectionOptions): Promise<Connection> {
    checkSessionKey(options.key);
    return new Connection(socket, options, { name: 'await-hello' }).#ready.promise;
  }

  /** 客户端：以给定角色发起握手。 */
  static open(socket: Socket, role: string, options: ConnectionOptions): Promise<Connection> {
    checkSessionKey(options.key);
    if (!isRole.Check(role)) {
      socket.destroy();
      return Promise.reject(new ChannelError('protocol-error', `角色名不合法：${role}`));
    }
    const clientNonce = randomNonce();
    const connection = new Connection(socket, options, {
      name: 'await-challenge',
      role,
      clientNonce,
    });
    connection.#sendHandshake({ v: 1, type: 'hello', role, nonce: clientNonce });
    return connection.#ready.promise;
  }

  private constructor(socket: Socket, options: ConnectionOptions, step: Step) {
    super();
    this.#socket = socket;
    this.#key = options.key;
    this.#maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.#step = step;
    const timeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.#handshakeTimer = setTimeout(() => {
      this.destroy(new ChannelError('handshake-timeout', `握手未在 ${timeoutMs}ms 内完成`));
    }, timeoutMs);
    socket.on('data', (chunk: Buffer) => this.#onData(chunk));
    socket.on('error', (error) => {
      this.#error ??= new ChannelError('closed', error.message, { cause: error });
    });
    socket.on('close', () => this.#onClose());
  }

  /** 客户端声明并经认证的角色。 */
  get role(): string {
    return this.#role;
  }

  get isOpen(): boolean {
    return this.#step.name === 'open';
  }

  /** 发送一条 JSON 消息。连接未打开或超出帧长上限时抛出 ChannelError。 */
  send(message: unknown): void {
    this.#write(FrameKind.Json, Buffer.from(JSON.stringify(message), 'utf8'));
  }

  /** 发送一帧二进制数据；写入内核缓冲后才 resolve，供调用方施加背压。 */
  sendBinary(data: Uint8Array): Promise<void> {
    const frame = this.#frame(FrameKind.Binary, data);
    return new Promise((resolve, reject) => {
      this.#socket.write(frame, (error) => {
        if (error) reject(new ChannelError('closed', error.message, { cause: error }));
        else resolve();
      });
    });
  }

  /** 正常关闭：不再收发，通知对端后等待关闭，超过宽限期强制断开。 */
  close(): void {
    if (this.#step.name === 'closed') return;
    this.#step = { name: 'closed' };
    this.#socket.end();
    this.#closeTimer = setTimeout(() => this.#socket.destroy(), CLOSE_GRACE_MS);
    this.#closeTimer.unref();
  }

  /** 立即断开。 */
  destroy(error?: ChannelError): void {
    if (error) this.#error ??= error;
    this.#step = { name: 'closed' };
    clearTimeout(this.#handshakeTimer);
    if (error) this.#ready.reject(error);
    this.#socket.destroy();
  }

  #frame(kind: FrameKind, payload: Uint8Array): Buffer {
    if (this.#step.name !== 'open') throw new ChannelError('closed', '连接未打开');
    if (payload.byteLength > this.#maxFrameBytes) {
      throw new ChannelError(
        'frame-too-large',
        `负载 ${payload.byteLength} 字节超过上限 ${this.#maxFrameBytes}`,
      );
    }
    return encodeFrame(kind, payload);
  }

  #write(kind: FrameKind, payload: Uint8Array): void {
    this.#socket.write(this.#frame(kind, payload));
  }

  #sendHandshake(message: object): void {
    this.#socket.write(encodeFrame(FrameKind.Handshake, Buffer.from(JSON.stringify(message))));
  }

  #onData(chunk: Buffer): void {
    this.#decoder.push(chunk);
    this.#drain();
  }

  #drain(): void {
    while (!this.#gated && this.#step.name !== 'closed') {
      let frame: Frame | undefined;
      try {
        frame = this.#decoder.read();
      } catch (error) {
        this.destroy(asChannelError(error));
        return;
      }
      if (frame === undefined) return;
      if (this.#step.name === 'open') this.#deliver(frame);
      else this.#handshake(frame);
    }
  }

  #deliver(frame: Frame): void {
    if (frame.kind === FrameKind.Binary) {
      this.emit('binary', frame.payload);
      return;
    }
    if (frame.kind === FrameKind.Handshake) {
      this.destroy(new ChannelError('protocol-error', '认证后收到握手帧'));
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(frame.payload.toString('utf8'));
    } catch (error) {
      this.destroy(new ChannelError('protocol-error', '消息不是合法 JSON', { cause: error }));
      return;
    }
    this.emit('message', message);
  }

  #handshake(frame: Frame): void {
    if (frame.kind !== FrameKind.Handshake) {
      this.destroy(new ChannelError('protocol-error', '认证完成前收到业务数据'));
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(frame.payload.toString('utf8'));
    } catch (error) {
      this.destroy(new ChannelError('protocol-error', '握手消息不是合法 JSON', { cause: error }));
      return;
    }
    const step = this.#step;
    switch (step.name) {
      case 'await-hello': {
        if (!isHello.Check(message)) {
          this.#reject('hello');
          return;
        }
        const serverNonce = randomNonce();
        this.#step = {
          name: 'await-proof',
          role: message.role,
          clientNonce: message.nonce,
          serverNonce,
        };
        const proof = this.#prove('server', message.role, message.nonce, serverNonce);
        this.#sendHandshake({ v: 1, type: 'challenge', nonce: serverNonce, proof });
        return;
      }
      case 'await-challenge': {
        if (!isChallenge.Check(message)) {
          this.#reject('challenge');
          return;
        }
        if (!this.#verify(message.proof, 'server', step.role, step.clientNonce, message.nonce)) {
          this.destroy(
            new ChannelError('auth-failed', '服务端未能证明持有会话密钥，地址可能被抢注'),
          );
          return;
        }
        const proof = this.#prove('client', step.role, step.clientNonce, message.nonce);
        this.#sendHandshake({ v: 1, type: 'proof', proof });
        this.#step = { name: 'await-accept', role: step.role };
        return;
      }
      case 'await-proof': {
        if (!isProof.Check(message)) {
          this.#reject('proof');
          return;
        }
        if (!this.#verify(message.proof, 'client', step.role, step.clientNonce, step.serverNonce)) {
          this.destroy(
            new ChannelError('auth-failed', `客户端（${step.role}）未能证明持有会话密钥`),
          );
          return;
        }
        this.#sendHandshake({ v: 1, type: 'accept' });
        this.#open(step.role);
        return;
      }
      case 'await-accept': {
        if (!isAccept.Check(message)) {
          this.#reject('accept');
          return;
        }
        this.#open(step.role);
        return;
      }
      default:
        return;
    }
  }

  #reject(expected: string): void {
    this.destroy(new ChannelError('protocol-error', `握手消息不合法，期望 ${expected}`));
  }

  #open(role: string): void {
    clearTimeout(this.#handshakeTimer);
    this.#role = role;
    this.#step = { name: 'open' };
    this.#decoder.maxPayloadBytes = this.#maxFrameBytes;
    // 让拿到连接的一方先挂上监听器，再分发握手后已到达的帧。
    this.#gated = true;
    this.#ready.resolve(this);
    setImmediate(() => {
      this.#gated = false;
      this.#drain();
    });
  }

  #mac(...args: MacArgs): Buffer {
    return createHmac('sha256', this.#key)
      .update(JSON.stringify([PROOF_DOMAIN, ...args]))
      .digest();
  }

  #prove(...args: MacArgs): string {
    return this.#mac(...args).toString('base64url');
  }

  #verify(proof: string, ...args: MacArgs): boolean {
    const actual = Buffer.from(proof, 'base64url');
    const expected = this.#mac(...args);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  #onClose(): void {
    clearTimeout(this.#handshakeTimer);
    clearTimeout(this.#closeTimer);
    const wasOpen = this.#step.name === 'open';
    this.#step = { name: 'closed' };
    if (!wasOpen && this.#role === '') {
      this.#error ??= new ChannelError('closed', '握手完成前连接已关闭');
    }
    this.#ready.reject(this.#error ?? new ChannelError('closed', '连接已关闭'));
    if (this.#closeEmitted) return;
    this.#closeEmitted = true;
    this.emit('close', this.#error);
  }
}
