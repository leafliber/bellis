import type { Clock, TimerHandle } from '@bellis/kernel';
import WebSocket from 'ws';

export const VTS_API_NAME = 'VTubeStudioPublicAPI';
export const VTS_API_VERSION = '1.0';

/** 本插件处理的 VTS 错误编号（见 VTS 仓库的 ErrorID.cs）。 */
export const VtsErrorId = {
  /** 会话尚未认证，或用户已在 VTS 中撤销了插件。 */
  RequestRequiresAuthentication: 8,
  /** 用户在弹窗中拒绝了令牌申请。 */
  TokenRequestDenied: 50,
  /** `set` 模式下参数已由其他插件写入。 */
  InjectDataParamControlledByOtherPlugin: 454,
} as const;

/** 一次请求的应答：成功时是对应的响应消息，失败时是 VTS 的 APIError。 */
export type VtsResponse =
  | { ok: true; messageType: string; data: Record<string, unknown> }
  | { ok: false; errorId: number; message: string };

export class VtsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VtsError';
  }
}

interface Pending {
  resolve(response: VtsResponse): void;
  reject(error: Error): void;
  timer: TimerHandle;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * VTube Studio 插件 API 的客户端（R-15）：JSON 文本消息，按 requestID 配对请求与应答；只发请求，
 * 不订阅事件。截止时间经插件的时钟计时。请求内容（例如插件令牌）不写进任何错误信息。
 *
 * 用 `ws` 并关闭 permessage-deflate（R-10）：Node 自带的 WebSocket 会请求压缩，VTS 接受后每条消息
 * 发一个以结束块收尾的完整 deflate 流，自带客户端只解得出第一条，之后的应答都成了空消息（真机 VTS 1.35.10 实测）。
 */
export class VtsClient {
  readonly #socket: WebSocket;
  readonly #clock: Clock;
  readonly #pending = new Map<string, Pending>();
  readonly #closeListeners = new Set<(reason: string) => void>();
  #next = 0;
  #closed = false;

  private constructor(socket: WebSocket, clock: Clock) {
    this.#socket = socket;
    this.#clock = clock;
    socket.on('message', (data, binary) => {
      if (!binary) this.#onMessage(data.toString());
    });
    socket.on('close', (code) => this.#onClose(`code=${code}`));
  }

  /** 建立连接；VTS 不在或截止时间内没连上即失败。 */
  static connect(url: string, clock: Clock, timeoutMs: number): Promise<VtsClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { perMessageDeflate: false });
      // 连接出错之后总会关闭，由关闭处理；没有错误监听时 ws 会把错误抛成进程异常。
      socket.on('error', () => {});
      const cleanup = () => {
        clock.clearTimeout(timer);
        socket.off('open', onOpen);
        socket.off('error', onError);
        socket.off('close', onClose);
      };
      const fail = (error: Error) => {
        cleanup();
        socket.close();
        reject(error);
      };
      const onOpen = () => {
        cleanup();
        resolve(new VtsClient(socket, clock));
      };
      const onError = () => fail(new VtsError(`无法连接 VTube Studio：${url}`));
      const onClose = (code: number) =>
        fail(new VtsError(`VTube Studio 连接在建立时关闭：${code}`));
      const timer = clock.setTimeout(
        () => fail(new VtsError(`连接 VTube Studio 未在 ${timeoutMs}ms 内完成`)),
        timeoutMs,
      );
      socket.once('open', onOpen);
      socket.once('error', onError);
      socket.once('close', onClose);
    });
  }

  get connected(): boolean {
    return !this.#closed;
  }

  onClose(listener: (reason: string) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  /** 发一个请求，等它的应答；连接关闭或超时即失败。 */
  request(
    messageType: string,
    data: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<VtsResponse> {
    if (this.#closed) return Promise.reject(new VtsError('VTube Studio 连接已关闭'));
    this.#next += 1;
    const requestID = `bellis-${this.#next}`;
    return new Promise((resolve, reject) => {
      const timer = this.#clock.setTimeout(() => {
        this.#pending.delete(requestID);
        reject(new VtsError(`VTube Studio 未在 ${timeoutMs}ms 内应答 ${messageType}`));
      }, timeoutMs);
      this.#pending.set(requestID, { resolve, reject, timer });
      try {
        this.#socket.send(
          JSON.stringify({
            apiName: VTS_API_NAME,
            apiVersion: VTS_API_VERSION,
            requestID,
            messageType,
            data,
          }),
        );
      } catch {
        this.#clock.clearTimeout(timer);
        this.#pending.delete(requestID);
        reject(new VtsError(`发送 ${messageType} 失败：连接不可用`));
      }
    });
  }

  close(): void {
    this.#socket.close();
  }

  #onMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message.requestID !== 'string') return;
    if (typeof message.messageType !== 'string') return;
    const pending = this.#pending.get(message.requestID);
    if (!pending) return;
    this.#clock.clearTimeout(pending.timer);
    this.#pending.delete(message.requestID);
    const data = isRecord(message.data) ? message.data : {};
    pending.resolve(
      message.messageType === 'APIError'
        ? {
            ok: false,
            errorId: typeof data.errorID === 'number' ? data.errorID : -1,
            message: typeof data.message === 'string' ? data.message : '',
          }
        : { ok: true, messageType: message.messageType, data },
    );
  }

  #onClose(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      this.#clock.clearTimeout(pending.timer);
      pending.reject(new VtsError(`VTube Studio 连接已关闭：${reason}`));
    }
    this.#pending.clear();
    for (const listener of [...this.#closeListeners]) listener(reason);
  }
}
