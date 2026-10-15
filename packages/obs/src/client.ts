import { randomUUID } from 'node:crypto';
import {
  AuthenticationFailed,
  authenticationString,
  type Message,
  type ObsRequest,
  type ObsResult,
  OpCode,
  SerialRealtime,
  SUBPROTOCOL,
} from './protocol.ts';

export interface ObsConnectOptions {
  /** 握手与认证的截止时间，默认 2000ms。 */
  timeoutMs?: number;
}

export interface ObsRequestOptions {
  /** 默认 2000ms。 */
  timeoutMs?: number;
}

export class ObsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObsError';
  }
}

interface Pending {
  resolve(message: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

function toResult(raw: Record<string, unknown>): ObsResult {
  const status = (raw.requestStatus ?? {}) as { result?: boolean; code?: number; comment?: string };
  return {
    requestType: String(raw.requestType),
    ok: status.result === true,
    code: status.code ?? 0,
    ...(status.comment === undefined ? {} : { comment: status.comment }),
    ...(raw.responseData === undefined
      ? {}
      : { data: raw.responseData as Record<string, unknown> }),
  };
}

/**
 * obs-websocket 5 客户端（JSON 子协议）。不订阅事件，只发请求与批量请求。
 * 安全核的 OBS 应急连接与外部看门狗都用它（D-30、R-14）。
 */
export class ObsClient {
  readonly #socket: WebSocket;
  readonly #pending = new Map<string, Pending>();
  readonly #closeListeners = new Set<(reason: string) => void>();
  #closed = false;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => this.#onMessage(String(event.data)));
    socket.addEventListener('close', (event) =>
      this.#onClose(`code=${event.code} ${event.reason}`),
    );
  }

  /** 连接并完成 Hello / Identify 认证。 */
  static connect(
    url: string,
    password: string | undefined,
    options: ObsConnectOptions = {},
  ): Promise<ObsClient> {
    const timeoutMs = options.timeoutMs ?? 2000;
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, SUBPROTOCOL);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener('error', onError);
        socket.removeEventListener('close', onClose);
        socket.removeEventListener('message', onMessage);
      };
      const fail = (error: Error) => {
        cleanup();
        socket.close();
        reject(error);
      };
      const onError = () => fail(new ObsError(`无法连接 OBS：${url}`));
      const onClose = (event: CloseEvent) =>
        fail(
          new ObsError(
            event.code === AuthenticationFailed
              ? 'OBS 认证失败'
              : `OBS 连接在握手中关闭：${event.code}`,
          ),
        );
      const onMessage = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data)) as Message;
        if (message.op === OpCode.Hello) {
          const auth = message.d.authentication as { challenge: string; salt: string } | undefined;
          if (auth && password === undefined) {
            fail(new ObsError('OBS 要求认证，但没有提供密码'));
            return;
          }
          socket.send(
            JSON.stringify({
              op: OpCode.Identify,
              d: {
                rpcVersion: 1,
                eventSubscriptions: 0,
                ...(auth && password !== undefined
                  ? { authentication: authenticationString(password, auth.salt, auth.challenge) }
                  : {}),
              },
            }),
          );
        } else if (message.op === OpCode.Identified) {
          cleanup();
          resolve(new ObsClient(socket));
        }
      };
      const timer = setTimeout(
        () => fail(new ObsError(`OBS 握手未在 ${timeoutMs}ms 内完成`)),
        timeoutMs,
      );
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose);
      socket.addEventListener('message', onMessage);
    });
  }

  get connected(): boolean {
    return !this.#closed;
  }

  onClose(listener: (reason: string) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  async request(
    requestType: string,
    requestData?: Record<string, unknown>,
    options: ObsRequestOptions = {},
  ): Promise<ObsResult> {
    const requestId = randomUUID();
    const raw = await this.#send(
      {
        op: OpCode.Request,
        d: { requestType, requestId, ...(requestData ? { requestData } : {}) },
      },
      requestId,
      options.timeoutMs,
    );
    return toResult(raw);
  }

  /** 一次发送一组请求；默认按顺序实时执行，失败不中断。 */
  async batch(
    requests: readonly ObsRequest[],
    options: ObsRequestOptions & { haltOnFailure?: boolean } = {},
  ): Promise<ObsResult[]> {
    const requestId = randomUUID();
    const raw = await this.#send(
      {
        op: OpCode.RequestBatch,
        d: {
          requestId,
          haltOnFailure: options.haltOnFailure ?? false,
          executionType: SerialRealtime,
          requests,
        },
      },
      requestId,
      options.timeoutMs,
    );
    return ((raw.results ?? []) as Array<Record<string, unknown>>).map(toResult);
  }

  close(): void {
    this.#socket.close();
  }

  #send(message: Message, requestId: string, timeoutMs = 2000): Promise<Record<string, unknown>> {
    if (this.#closed) return Promise.reject(new ObsError('OBS 连接已关闭'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new ObsError(`OBS 请求未在 ${timeoutMs}ms 内响应`));
      }, timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timer });
      this.#socket.send(JSON.stringify(message));
    });
  }

  #onMessage(text: string): void {
    const message = JSON.parse(text) as Message;
    if (message.op !== OpCode.RequestResponse && message.op !== OpCode.RequestBatchResponse) return;
    const id = String(message.d.requestId);
    const pending = this.#pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    pending.resolve(message.d);
  }

  #onClose(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ObsError(`OBS 连接已关闭：${reason}`));
    }
    this.#pending.clear();
    for (const listener of this.#closeListeners) listener(reason);
  }
}
