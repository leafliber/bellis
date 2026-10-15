import {
  RpcCancel,
  RpcCancelParams,
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
const isCancel = Compile(RpcCancelParams);

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
  /** 请求方取消（超时或中止）或连接关闭时中止。 */
  signal: AbortSignal;
}

export interface RpcPeerOptions {
  /** 请求的默认截止时间。 */
  timeoutMs: number;
  /** 同时处理的对端请求上限，默认 64；超出时以 ServerBusy 拒绝。 */
  maxInflight?: number;
}

const DEFAULT_MAX_INFLIGHT = 64;

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
 * 每个请求都有截止时间；超时或中止时向对端发 `rpc.cancel`，对端中止对应的处理。
 * 连接关闭时，未完成的请求以 `closed` 失败，正在处理的请求收到中止信号。
 * 重试是否会重复产生副作用不在这一层解决：副作用由意图的幂等键去重（见状态存储）。
 */
export class RpcPeer {
  readonly connection: Connection;
  readonly #timeoutMs: number;
  readonly #pending = new Map<RpcId, Pending>();
  readonly #handlers = new Map<string, RpcHandler>();
  readonly #notificationHandlers = new Map<string, NotificationHandler>();
  readonly #inflight = new Map<RpcId, AbortController>();
  readonly #maxInflight: number;
  #nextId = 1;

  constructor(connection: Connection, options: RpcPeerOptions) {
    this.connection = connection;
    this.#timeoutMs = options.timeoutMs;
    this.#maxInflight = options.maxInflight ?? DEFAULT_MAX_INFLIGHT;
    connection.on('message', (message) => this.#receive(message));
    connection.on('close', () => this.#onClose());
  }

  /** 注册请求处理函数，返回撤销函数。同名方法只能有一个处理函数。 */
  handle(method: string, handler: RpcHandler): () => void {
    reserved(method);
    return register(this.#handlers, method, handler);
  }

  /** 注册通知处理函数，返回撤销函数。 */
  onNotification(method: string, handler: NotificationHandler): () => void {
    reserved(method);
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
    const cancel = () => {
      if (this.connection.isOpen)
        this.connection.send(withParams({ jsonrpc: '2.0', method: RpcCancel }, { id }));
    };
    const onAbort = () => {
      settle();
      cancel();
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      settle();
      cancel();
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
      if (message.method === RpcCancel) {
        if (isCancel.Check(message.params)) {
          this.#inflight.get(message.params.id)?.abort(new ChannelError('closed', '请求方已取消'));
        }
        return;
      }
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
    if (this.#inflight.has(request.id)) {
      this.#reply({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: RpcErrorCode.InvalidRequest, message: 'Duplicate request id' },
      });
      return;
    }
    if (this.#inflight.size >= this.#maxInflight) {
      this.#reply({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: RpcErrorCode.ServerBusy, message: 'Server busy' },
      });
      return;
    }
    const controller = new AbortController();
    this.#inflight.set(request.id, controller);
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
      this.#inflight.delete(request.id);
    }
  }

  #reply(message: RpcSuccess | RpcFailure): void {
    if (this.connection.isOpen) this.connection.send(message);
  }

  #onClose(): void {
    for (const pending of [...this.#pending.values()]) {
      pending.reject(new ChannelError('closed', '连接已关闭，请求未完成'));
    }
    for (const controller of this.#inflight.values()) {
      controller.abort(new ChannelError('closed', '连接已关闭'));
    }
  }
}

function reserved(method: string): void {
  if (method.startsWith('rpc.')) throw new Error('rpc. 前缀保留给协议自身');
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
