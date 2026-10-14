import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import {
  type ChannelCredentials,
  type Connection,
  type ConnectionOptions,
  connect,
  createChannelPath,
  createSessionKey,
  encodeFrame,
  type Frame,
  FrameDecoder,
  type FrameKind,
  listen,
} from '../src/index.ts';

export function testCredentials(): ChannelCredentials & { key: Buffer } {
  return { path: createChannelPath(`t${randomBytes(4).toString('hex')}`), key: createSessionKey() };
}

/** 建立一对已认证的连接，用完调用 close。 */
export async function connectedPair(options: Partial<ConnectionOptions> = {}) {
  const { path, key } = testCredentials();
  const accepted = Promise.withResolvers<Connection>();
  const server = await listen(path, { key, ...options, onConnection: accepted.resolve });
  const client = await connect(path, 'test.client', { key, ...options });
  const serverSide = await accepted.promise;
  return { client, server: serverSide, close: () => server.close() };
}

/** 不做握手的原始对端，用来构造攻击和异常输入。 */
export class RawPeer {
  readonly socket: Socket;
  readonly frames: Frame[] = [];
  readonly closed: Promise<unknown>;
  readonly #decoder = new FrameDecoder(1024 * 1024);
  #waiters: Array<() => void> = [];

  constructor(socket: Socket) {
    this.socket = socket;
    this.closed = once(socket, 'close');
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => {
      this.#decoder.push(chunk);
      for (let frame = this.#decoder.read(); frame; frame = this.#decoder.read()) {
        this.frames.push(frame);
      }
      for (const wake of this.#waiters.splice(0)) wake();
    });
  }

  static async connect(path: string): Promise<RawPeer> {
    const socket = createConnection(path);
    await once(socket, 'connect');
    return new RawPeer(socket);
  }

  send(kind: FrameKind, body: object | Buffer): void {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    this.socket.write(encodeFrame(kind, payload));
  }

  /** 等到收到第 n 帧（从 1 计）。 */
  async frame(n: number): Promise<Frame> {
    while (this.frames.length < n) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    return this.frames[n - 1] as Frame;
  }

  json(frame: Frame): Record<string, unknown> {
    return JSON.parse(frame.payload.toString('utf8'));
  }
}

export function nonce(): string {
  return randomBytes(32).toString('base64url');
}
