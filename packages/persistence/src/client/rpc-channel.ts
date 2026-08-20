import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { TraceContext } from "@bellis/contracts";
import type { LoggerPort } from "@bellis/observability";
import { PersistenceError } from "../errors.js";
import { PersistenceRpcResponseSchema, isCheckpointNotice } from "../rpc/envelope.js";
import { decodeOperationResult, encodeOperationPayload } from "../rpc/operations.js";
import type {
  OperationRequest,
  OperationResults,
  PersistenceOperation,
} from "../rpc/operations.js";

/**
 * 主线程 RPC 通道（P2 文档 §5.1）。
 *
 * - requestId 关联响应；未知/迟到响应丢弃并记录诊断事件。
 * - Deadline：客户端定时器 + Envelope deadlineUs（Worker 事务开始前检查）。
 * - Worker 崩溃/退出：所有在飞 Promise 以同一 unavailable 错误结束，
 *   通道进入不可用状态，直到调用方销毁重建。
 * - 检查点通知路由到观察器；观察器正常返回 → 释放继续，抛出 → 释放回滚。
 * - close()：拒绝新请求，等待在飞（Grace），最终 terminate Worker。
 */
/* Node MessagePort/Worker 的 postMessage 没有 targetOrigin（浏览器规则误报，文件级关闭）。 */
/* oxlint-disable unicorn/require-post-message-target-origin */

interface PendingRequest {
  readonly operation: PersistenceOperation;
  readonly controller: AbortController;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: PersistenceError) => void;
  readonly timer: NodeJS.Timeout;
}

export interface RpcCallOptions {
  readonly deadlineMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface CheckpointNotice {
  readonly checkpoint: string;
  readonly context: {
    readonly traceId: string;
    readonly sceneId?: string | undefined;
    readonly outboxId?: string | undefined;
  };
  readonly signal: AbortSignal;
}

export type CheckpointNoticeHandler = (notice: CheckpointNotice) => Promise<void>;

export interface RpcChannelOptions {
  readonly workerUrl: URL;
  readonly execArgv?: readonly string[] | undefined;
  readonly workerData: Record<string, unknown>;
  readonly defaultDeadlineMs: number;
  readonly logger: LoggerPort;
  readonly onCheckpointNotice?: CheckpointNoticeHandler | undefined;
}

const CLOSE_GRACE_POLL_MS = 10;

export class PersistenceRpcChannel {
  readonly worker: Worker;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #logger: LoggerPort;
  readonly #defaultDeadlineMs: number;
  readonly #onCheckpointNotice: CheckpointNoticeHandler | undefined;
  #closing = false;
  #closed = false;

  constructor(options: RpcChannelOptions) {
    this.#logger = options.logger;
    this.#defaultDeadlineMs = options.defaultDeadlineMs;
    this.#onCheckpointNotice = options.onCheckpointNotice;
    this.worker = new Worker(options.workerUrl, {
      execArgv: options.execArgv === undefined ? [] : [...options.execArgv],
      workerData: options.workerData,
    });
    this.worker.on("message", (message: unknown) => {
      this.#onMessage(message);
    });
    this.worker.on("error", (error: Error) => {
      this.#failAll(
        new PersistenceError("unavailable", "persistence worker failed", { cause: error }),
      );
    });
    this.worker.on("exit", (code: number) => {
      this.#failAll(
        new PersistenceError("unavailable", `persistence worker exited (code ${code})`),
      );
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  async call<K extends PersistenceOperation>(
    message: OperationRequest<K>,
    trace: TraceContext,
    options?: RpcCallOptions,
  ): Promise<OperationResults[K]> {
    if (this.#closed || this.#closing) {
      throw new PersistenceError("closed", "persistence client is closed");
    }
    const requestId = randomUUID();
    const deadlineMs = options?.deadlineMs ?? this.#defaultDeadlineMs;
    const deadlineUs = BigInt(Date.now()) * 1000n + BigInt(deadlineMs) * 1000n;
    const request = {
      version: 1 as const,
      requestId,
      operation: message.operation,
      deadlineUs: deadlineUs.toString(10),
      trace,
      payload: encodeOperationPayload(message as OperationRequest),
    };
    return this.#exchange(request, message, deadlineMs, options?.signal);
  }

  #exchange<K extends PersistenceOperation>(
    request: { readonly requestId: string },
    message: OperationRequest<K>,
    deadlineMs: number,
    signal: AbortSignal | undefined,
  ): Promise<OperationResults[K]> {
    return new Promise<OperationResults[K]>((resolve, reject) => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        this.#pending.delete(request.requestId);
        controller.abort();
        reject(new PersistenceError("deadline_exceeded", "request timed out"));
      }, deadlineMs);
      const settle = (cleanup: () => void) => {
        clearTimeout(timer);
        cleanup();
      };
      const entry: PendingRequest = {
        operation: message.operation,
        controller,
        resolve: (value) => resolve(value as OperationResults[K]),
        reject,
        timer,
      };
      this.#pending.set(request.requestId, entry);
      if (signal !== undefined) {
        const onAbort = () => {
          const pending = this.#pending.get(request.requestId);
          if (pending !== undefined) {
            settle(() => this.#pending.delete(request.requestId));
            reject(new PersistenceError("unavailable", "request aborted"));
          }
        };
        if (signal.aborted) {
          settle(() => this.#pending.delete(request.requestId));
          reject(new PersistenceError("unavailable", "request aborted"));
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.worker.postMessage(request);
    });
  }

  #onMessage(message: unknown): void {
    if (isCheckpointNotice(message)) {
      void this.#handleCheckpointNotice(message.requestId, message.checkpoint, message.context);
      return;
    }
    const parsed = PersistenceRpcResponseSchema.safeParse(message);
    if (!parsed.success) {
      this.#logger.log("warn", "persistence_rpc_malformed_response_dropped", {});
      return;
    }
    const response = parsed.data;
    const pending = this.#pending.get(response.requestId);
    if (pending === undefined) {
      this.#logger.log("warn", "persistence_rpc_late_response_dropped", {
        requestId: response.requestId,
      });
      return;
    }
    this.#pending.delete(response.requestId);
    clearTimeout(pending.timer);
    if (response.ok) {
      try {
        const decoded = decodeOperationResult(pending.operation, response.payload);
        pending.resolve(decoded.result);
      } catch (error) {
        pending.reject(
          error instanceof PersistenceError
            ? error
            : new PersistenceError("internal", "malformed worker response"),
        );
      }
      return;
    }
    if (response.error === undefined) {
      pending.reject(new PersistenceError("internal", "malformed worker response"));
      return;
    }
    const safe = response.error;
    pending.reject(new PersistenceError(safe.code, safe.message, { retryable: safe.retryable }));
  }

  async #handleCheckpointNotice(
    requestId: string,
    checkpoint: string,
    context: {
      readonly traceId: string;
      readonly sceneId?: string | undefined;
      readonly outboxId?: string | undefined;
    },
  ): Promise<void> {
    const release = (proceed: boolean) => {
      this.worker.postMessage({
        type: "persistence_checkpoint_release",
        version: 1,
        requestId,
        proceed,
      });
    };
    const pending = this.#pending.get(requestId);
    if (pending === undefined || this.#onCheckpointNotice === undefined) {
      release(false);
      return;
    }
    try {
      await this.#onCheckpointNotice({
        checkpoint,
        context,
        signal: pending.controller.signal,
      });
      release(true);
    } catch {
      release(false);
    }
  }

  #failAll(error: PersistenceError): void {
    this.#closed = true;
    for (const [requestId, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(requestId);
      pending.controller.abort();
      pending.reject(error);
    }
  }

  async close(graceMs: number): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closing = true;
    const deadline = Date.now() + graceMs;
    while (this.#pending.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, CLOSE_GRACE_POLL_MS));
    }
    this.#failAll(new PersistenceError("closed", "persistence client closed"));
    await this.worker.terminate();
  }
}
