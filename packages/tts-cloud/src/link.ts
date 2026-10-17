import { type Clock, withDeadline } from '@bellis/kernel';
import WebSocket from 'ws';
import { EngineError } from './engine.ts';

export interface LinkOptions {
  url: string;
  /** 建连请求头（含鉴权）；不写日志。 */
  headers: Readonly<Record<string, string>>;
  clock: Clock;
  /** 建连（含 TLS 与 HTTP 升级）的截止时间。 */
  timeoutMs: number;
  /** 单条消息上限。 */
  maxPayload: number;
}

const UNEXPECTED = /Unexpected server response: (\d+)/;
/** 关闭握手等不到对端时，过这么久直接断开。 */
const CLOSE_GRACE_MS = 1000;

function failure(error: Error): EngineError {
  const status = UNEXPECTED.exec(error.message)?.[1];
  if (status === '401' || status === '403') {
    return new EngineError(`鉴权失败（HTTP ${status}）`, { auth: true });
  }
  if (status) return new EngineError(`建连被拒（HTTP ${status}）`);
  return new EngineError(`连接失败：${error.message}`);
}

/**
 * 到 TTS 厂商的一条 WebSocket 连接（客户端，`ws`）。只负责建连、收发与关闭；
 * 协议与会话状态由各厂商的适配器管理。建连失败时以 {@link EngineError} 拒绝，HTTP 401/403 标为鉴权失败。
 * 接收者接上之前到达的消息先缓存，不会丢。
 */
export class Link {
  readonly #ws: WebSocket;
  readonly #early: Array<[Buffer, boolean]> = [];
  #headers: Readonly<Record<string, string | string[] | undefined>> = {};
  #onMessage: ((data: Buffer, binary: boolean) => void) | undefined;
  #onClose: ((reason: string) => void) | undefined;
  #closed = false;
  #closeReason: string | undefined;

  private constructor(options: LinkOptions) {
    const ws = new WebSocket(options.url, {
      headers: { ...options.headers },
      handshakeTimeout: options.timeoutMs,
      maxPayload: options.maxPayload,
      perMessageDeflate: false,
    });
    this.#ws = ws;
    ws.on('upgrade', (response) => {
      this.#headers = response.headers;
    });
    ws.on('message', (data, binary) => {
      const buffer = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      if (this.#onMessage) this.#onMessage(buffer, binary);
      else this.#early.push([buffer, binary]);
    });
    ws.on('close', (code, reason) =>
      this.#gone(`关闭 ${code}${reason.length > 0 ? ` ${reason.toString('utf8')}` : ''}`),
    );
    ws.on('error', (error) => this.#gone(`出错：${error.message}`));
  }

  static async open(options: LinkOptions): Promise<Link> {
    const link = new Link(options);
    const ws = link.#ws;
    const opened = new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (error) => reject(failure(error)));
      ws.once('close', () => reject(new EngineError(`连接失败：${link.#closeReason ?? '已关闭'}`)));
    });
    try {
      await withDeadline(options.clock, opened, options.timeoutMs, '建连');
    } catch (error) {
      ws.terminate();
      if (error instanceof EngineError) throw error;
      throw new EngineError(error instanceof Error ? error.message : String(error));
    }
    return link;
  }

  /** 握手响应头（例如火山引擎的 X-Tt-Logid，便于排查）；不含凭据。 */
  get responseHeaders(): Readonly<Record<string, string | string[] | undefined>> {
    return this.#headers;
  }

  get isOpen(): boolean {
    return !this.#closed && this.#ws.readyState === WebSocket.OPEN;
  }

  onMessage(listener: (data: Buffer, binary: boolean) => void): void {
    this.#onMessage = listener;
    for (const [data, binary] of this.#early.splice(0)) listener(data, binary);
  }

  /** 连接断开（对端关闭、出错或本端关闭）时调用一次。 */
  onClose(listener: (reason: string) => void): void {
    this.#onClose = listener;
    if (this.#closed) listener(this.#closeReason ?? '已关闭');
  }

  send(data: string | Uint8Array): void {
    if (!this.isOpen) throw new EngineError('连接已关闭');
    this.#ws.send(data);
  }

  ping(): void {
    if (this.isOpen) this.#ws.ping();
  }

  close(): void {
    if (this.#ws.readyState !== WebSocket.CLOSED) {
      this.#ws.close(1000);
      setTimeout(() => this.#ws.terminate(), CLOSE_GRACE_MS).unref();
    }
    this.#gone('本端关闭');
  }

  #gone(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = reason;
    this.#onClose?.(reason);
  }
}
