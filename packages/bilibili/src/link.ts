import type { Clock, TimerHandle } from '@bellis/kernel';
import WebSocket from 'ws';
import { decodePackets, encodePacket, Operation, type Packet } from './packet.ts';

export interface LinkOptions {
  url: string;
  /** 开启场次时拿到的认证正文，原样作为认证包的正文；不写日志。 */
  authBody: string;
  clock: Clock;
  /** 建连（含 TLS 与 HTTP 升级）的截止时间。 */
  connectTimeoutMs: number;
  /** 发出认证包到收到认证回复的截止时间。 */
  authTimeoutMs: number;
  heartbeatIntervalMs: number;
  /** 这么久收不到任何包（含心跳回复）就视为断开。 */
  idleTimeoutMs: number;
  /** 单条 WebSocket 消息的上限。 */
  maxPayload: number;
  /** 中止即关闭（建连与认证期间中止则以 {@link LinkError} 失败）。 */
  signal: AbortSignal;
}

/** 一条业务消息（Operation 5）：`{"cmd": …, "data": …}`。 */
export interface LinkCommand {
  cmd: string;
  data: unknown;
}

export interface LinkHandlers {
  command(command: LinkCommand): void;
  /** 收到格式不对的包或消息；只带原因，不带内容。 */
  malformed(reason: string): void;
}

/** 建连或认证失败。`auth` 为 true 表示平台拒绝了认证（认证正文可能已失效，需重新开启场次）。 */
export class LinkError extends Error {
  readonly auth: boolean;

  constructor(message: string, options: { auth?: boolean } = {}) {
    super(message);
    this.name = 'LinkError';
    this.auth = options.auth ?? false;
  }
}

/** 关闭握手等不到对端时，过这么久直接断开。 */
const CLOSE_GRACE_MS = 1000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 到开放平台长连接的一条连接（客户端，`ws`）：建连 → 认证（Operation 7，正文原样放 auth_body）→ 等认证回复
 * （Operation 8，正文 `code` 为 0 表示成功；只有社区实现的出处，PENDING）→ 每隔一段时间发心跳（Operation 2）。
 * 认证回复之前不发任何别的包。收到的包按 {@link decodePackets} 拆开（含 zlib 与 brotli 的批量包）；
 * 一段时间收不到任何包（含心跳回复）就关闭，由调用方重连。
 */
export class LiveLink {
  readonly host: string;
  /** 连接关闭（对端关闭、出错、空闲超时或本端关闭）时给出原因。 */
  readonly closed: Promise<string>;
  readonly #ws: WebSocket;
  readonly #options: LinkOptions;
  readonly #handlers: LinkHandlers;
  #resolveClosed!: (reason: string) => void;
  #gone: string | undefined;
  #authed = false;
  #onAuth: ((code: number | undefined) => void) | undefined;
  #heartbeat: TimerHandle | undefined;
  #idle: TimerHandle | undefined;
  #lastPacketAt: number;

  private constructor(options: LinkOptions, handlers: LinkHandlers) {
    this.#options = options;
    this.#handlers = handlers;
    this.host = new URL(options.url).host;
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    this.#lastPacketAt = options.clock.now();
    const ws = new WebSocket(options.url, {
      handshakeTimeout: options.connectTimeoutMs,
      maxPayload: options.maxPayload,
      perMessageDeflate: false,
      followRedirects: false,
    });
    this.#ws = ws;
    ws.on('message', (data) => {
      const buffer = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      this.#receive(buffer);
    });
    ws.on('close', (code, reason) =>
      this.#finish(`对端关闭 ${code}${reason.length > 0 ? ` ${reason.toString('utf8')}` : ''}`),
    );
    ws.on('error', (error) => this.#finish(`出错：${error.message}`));
  }

  /** 建连并完成认证；失败时以 {@link LinkError} 拒绝，连接已关闭。 */
  static async open(options: LinkOptions, handlers: LinkHandlers): Promise<LiveLink> {
    if (options.signal.aborted) throw new LinkError('已取消');
    const link = new LiveLink(options, handlers);
    const abort = () => link.close('已取消');
    options.signal.addEventListener('abort', abort, { once: true });
    try {
      await link.#connect();
      await link.#authenticate();
    } catch (error) {
      options.signal.removeEventListener('abort', abort);
      link.close(errorText(error));
      throw error instanceof LinkError ? error : new LinkError(errorText(error));
    }
    link.closed.then(() => options.signal.removeEventListener('abort', abort));
    link.#startHeartbeat();
    return link;
  }

  get isOpen(): boolean {
    return this.#gone === undefined && this.#ws.readyState === WebSocket.OPEN;
  }

  close(reason: string): void {
    if (this.#ws.readyState !== WebSocket.CLOSED) {
      try {
        this.#ws.close(1000);
      } catch {
        // 建连尚未完成时 close 会抛错：直接断开。
        this.#ws.terminate();
      }
      setTimeout(() => this.#ws.terminate(), CLOSE_GRACE_MS).unref();
    }
    this.#finish(reason);
  }

  #connect(): Promise<void> {
    const { clock, connectTimeoutMs } = this.#options;
    return new Promise<void>((resolve, reject) => {
      const timer = clock.setTimeout(() => {
        reject(new LinkError(`建连未在 ${connectTimeoutMs}ms 内完成`));
      }, connectTimeoutMs);
      const done = (error?: LinkError) => {
        clock.clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      if (this.#gone !== undefined) {
        done(new LinkError(`连接失败：${this.#gone}`));
        return;
      }
      this.#ws.once('open', () => done());
      this.#ws.once('unexpected-response', (request, response) => {
        request.destroy();
        done(new LinkError(`建连被拒（HTTP ${response.statusCode ?? '?'}）`));
      });
      this.closed.then((reason) => done(new LinkError(`连接失败：${reason}`)));
    });
  }

  #authenticate(): Promise<void> {
    const { clock, authTimeoutMs } = this.#options;
    return new Promise<void>((resolve, reject) => {
      const timer = clock.setTimeout(() => {
        this.#onAuth = undefined;
        reject(new LinkError(`认证回复未在 ${authTimeoutMs}ms 内到达`));
      }, authTimeoutMs);
      this.#onAuth = (code) => {
        clock.clearTimeout(timer);
        this.#onAuth = undefined;
        if (code === 0) {
          this.#authed = true;
          resolve();
        } else {
          reject(new LinkError(`认证被拒（code ${code ?? '缺失'}）`, { auth: true }));
        }
      };
      this.closed.then((reason) => {
        if (!this.#onAuth) return;
        clock.clearTimeout(timer);
        this.#onAuth = undefined;
        reject(new LinkError(`认证前断开：${reason}`));
      });
      this.#send(encodePacket(Operation.Auth, this.#options.authBody));
    });
  }

  #startHeartbeat(): void {
    const { clock, heartbeatIntervalMs } = this.#options;
    const beat = () => {
      if (!this.isOpen) return;
      this.#send(encodePacket(Operation.Heartbeat));
      this.#heartbeat = clock.setTimeout(beat, heartbeatIntervalMs);
    };
    beat();
    this.#touch();
  }

  #touch(): void {
    const { clock, idleTimeoutMs } = this.#options;
    this.#lastPacketAt = clock.now();
    if (this.#idle) clock.clearTimeout(this.#idle);
    this.#idle = clock.setTimeout(() => {
      this.close(`${Math.round(clock.now() - this.#lastPacketAt)}ms 收不到任何包（含心跳回复）`);
    }, idleTimeoutMs);
  }

  #send(packet: Buffer): void {
    if (this.#ws.readyState === WebSocket.OPEN) this.#ws.send(packet);
  }

  #receive(buffer: Buffer): void {
    if (this.#gone !== undefined) return;
    if (this.#authed) this.#touch();
    let packets: Packet[];
    try {
      packets = decodePackets(buffer);
    } catch (error) {
      this.#handlers.malformed(errorText(error));
      return;
    }
    for (const packet of packets) {
      if (this.#gone !== undefined) return;
      if (packet.operation === Operation.AuthReply) {
        this.#onAuth?.(authCode(packet.body));
        continue;
      }
      // 认证回复之前到达的其它包不处理。
      if (!this.#authed) continue;
      if (packet.operation !== Operation.Message) continue;
      let parsed: { cmd?: unknown; data?: unknown };
      try {
        parsed = JSON.parse(packet.body.toString('utf8')) as typeof parsed;
      } catch {
        this.#handlers.malformed('消息正文不是 JSON');
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null || typeof parsed.cmd !== 'string') {
        this.#handlers.malformed('消息缺少 cmd');
        continue;
      }
      try {
        this.#handlers.command({ cmd: parsed.cmd, data: parsed.data });
      } catch (error) {
        this.#handlers.malformed(`处理消息出错：${error instanceof Error ? error.name : '未知'}`);
      }
    }
  }

  #finish(reason: string): void {
    if (this.#gone !== undefined) return;
    this.#gone = reason;
    const { clock } = this.#options;
    if (this.#heartbeat) clock.clearTimeout(this.#heartbeat);
    if (this.#idle) clock.clearTimeout(this.#idle);
    this.#heartbeat = undefined;
    this.#idle = undefined;
    this.#resolveClosed(reason);
  }
}

/** 认证回复正文里的 `code`；正文不是 JSON 或没有数值 code 时为 undefined。 */
function authCode(body: Buffer): number | undefined {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { code?: unknown };
    return typeof parsed?.code === 'number' ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}
