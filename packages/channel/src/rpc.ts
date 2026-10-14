import {
  RpcErrorCode,
  RpcFailure,
  type RpcId,
  RpcNotification,
  type RpcParams,
  RpcRequest,
  RpcSuccess,
} from '@bellis/protocol';
import { Compile } from 'typebox/compile';
import type { Connection } from './connection.ts';
import { ChannelError } from './errors.ts';

const isRequest = Compile(RpcRequest);
const isNotification = Compile(RpcNotification);
const isSuccess = Compile(RpcSuccess);
const isFailure = Compile(RpcFailure);

/** 对端返回的 JSON-RPC 错误；处理函数抛出它即可指定错误码。 */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

export interface RpcContext {
  /** 连接关闭时中止。 */
  signal: AbortSignal;
}

export type RpcHandler = (params: RpcParams, context: RpcContext) => unknown;
export type NotificationHandler = (params: RpcParams) => void;

export interface RequestOptions {
  /** 覆盖默认截止时间。 */
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

/**
 * 连接之上的 JSON-RPC 2.0 对端（D-21），双方都可以请求和响应。
 * 每个请求都有截止时间；连接关闭时，未完成的请求以 `closed` 失败，正在处理的请求收到中止信号。
 */
export class RpcPeer {
  readonly connection: Connection;
  readonly #timeoutMs: number;
  readonly #pending = new Map<RpcId, Pending>();
  readonly #handlers = new Map<string, RpcHandler>();
  readonly #notificationHandlers = new Map<string, NotificationHandler>();
  readonly #inflight = new Set<AbortController>();
  #nextId = 1;

  constructor(connection: Connection, options: { timeoutMs: number }) {
    this.connection = connection;
    this.#timeoutMs = options.timeoutMs;
    connection.on('message', (message) => this.#receive(message));
    connection.on('close', () => this.#onClose());
  }

  /** 注册请求处理函数，返回撤销函数。同名方法只能有一个处理函数。 */
  handle(method: string, handler: RpcHandler): () => void {
    return register(this.#handlers, method, handler);
  }

  /** 注册通知处理函数，返回撤销函数。 */
  onNotification(method: string, handler: NotificationHandler): () => void {
    return register(this.#notificationHandlers, method, handler);
  }

  request(method: string, params?: RpcParams, options: RequestOptions = {}): Promise<unknown> {
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = this.#nextId++;
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();

    const settle = () => {
      clearTimeout(timer);
      this.#pending.delete(id);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      settle();
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      settle();
      reject(new ChannelError('timeout', `${method} 未在 ${timeoutMs}ms 内响应`));
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    this.#pending.set(id, {
      resolve: (result) => {
        settle();
        resolve(result);
      },
      reject: (error) => {
        settle();
        reject(error);
      },
    });

    try {
      this.connection.send(withParams({ jsonrpc: '2.0', id, method }, params));
    } catch (error) {
      settle();
      reject(error);
    }
    return promise;
  }

  notify(method: string, params?: RpcParams): void {
    this.connection.send(withParams({ jsonrpc: '2.0', method }, params));
  }

  #receive(message: unknown): void {
    if (isRequest.Check(message)) {
      void this.#serve(message);
    } else if (isNotification.Check(message)) {
      this.#notificationHandlers.get(message.method)?.(message.params ?? {});
    } else if (isSuccess.Check(message)) {
      this.#pending.get(message.id)?.resolve(message.result);
    } else if (isFailure.Check(message)) {
      if (message.id === null) return;
      const { code, message: text, data } = message.error;
      this.#pending.get(message.id)?.reject(new RpcError(code, text, data));
    } else {
      this.#reply({
        jsonrpc: '2.0',
        id: null,
        error: { code: RpcErrorCode.InvalidRequest, message: 'Invalid Request' },
      });
    }
  }

  async #serve(request: RpcRequest): Promise<void> {
    const handler = this.#handlers.get(request.method);
    if (handler === undefined) {
      this.#reply({
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: RpcErrorCode.MethodNotFound,
          message: `Method not found: ${request.method}`,
        },
      });
      return;
    }
    const controller = new AbortController();
    this.#inflight.add(controller);
    try {
      const result = await handler(request.params ?? {}, { signal: controller.signal });
      this.#reply({ jsonrpc: '2.0', id: request.id, result: result ?? null });
    } catch (error) {
      // 处理函数的内部错误不外泄细节；需要告知对端的错误用 RpcError 抛出。
      const failure =
        error instanceof RpcError
          ? { code: error.code, message: error.message, ...withData(error.data) }
          : { code: RpcErrorCode.InternalError, message: 'Internal error' };
      this.#reply({ jsonrpc: '2.0', id: request.id, error: failure });
    } finally {
      this.#inflight.delete(controller);
    }
  }

  #reply(message: RpcSuccess | RpcFailure): void {
    if (this.connection.isOpen) this.connection.send(message);
  }

  #onClose(): void {
    for (const pending of [...this.#pending.values()]) {
      pending.reject(new ChannelError('closed', '连接已关闭，请求未完成'));
    }
    for (const controller of this.#inflight)
      controller.abort(new ChannelError('closed', '连接已关闭'));
  }
}

function register<T>(map: Map<string, T>, method: string, handler: T): () => void {
  if (map.has(method)) throw new Error(`方法 ${method} 已有处理函数`);
  map.set(method, handler);
  return () => {
    if (map.get(method) === handler) map.delete(method);
  };
}

function withParams<T extends object>(message: T, params: RpcParams | undefined) {
  return params === undefined ? message : { ...message, params };
}

function withData(data: unknown): { data?: unknown } {
  return data === undefined ? {} : { data };
}
