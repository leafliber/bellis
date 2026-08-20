import { parentPort } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import { parseDecimalString } from "@bellis/contracts";
import { PersistenceError } from "../errors.js";
import type { SafePersistenceError } from "../errors.js";
import {
  PersistenceCheckpointNoticeSchema,
  PersistenceRpcRequestSchema,
  isCheckpointRelease,
} from "../rpc/envelope.js";
import {
  decodeOperationPayload,
  encodeOperationResult,
  isPersistenceOperation,
} from "../rpc/operations.js";
import { mapSqliteError } from "./operations.js";
import type { OperationContext, WorkerOperationRuntime } from "./operations.js";

/**
 * Worker RPC Router（P2 文档 §5.1）。
 *
 * - Envelope 与 Operation Payload 双侧校验后才分发；未知操作稳定拒绝。
 * - 操作串行执行：单连接 SQLite 的事务不交错。
 * - 检查点桥：workerData.checkpointsEnabled 时，事务内检查点通过
 *   parentPort 通知主线程并等待释放；等待超时按 Deadline 处理回滚。
 * - 响应只携带安全错误；SQL/路径/原始 Payload 不跨边界。
 */
/* Node MessagePort/Worker 的 postMessage 没有 targetOrigin（浏览器规则误报，文件级关闭）。 */
/* oxlint-disable unicorn/require-post-message-target-origin */

interface PendingCheckpoint {
  readonly settle: (outcome: { proceed: boolean } | { fail: Error }) => void;
  readonly timeout: NodeJS.Timeout;
}

export interface RpcRouterOptions {
  readonly runtime: WorkerOperationRuntime;
  readonly checkpointsEnabled: boolean;
  readonly port: MessagePort;
}

/** 检查点等待的兜底上限：超过后按 Deadline 回滚，绝不无限挂起事务。 */
const CHECKPOINT_WAIT_TIMEOUT_MS = 60_000;

export class PersistenceRpcRouter {
  readonly #runtime: WorkerOperationRuntime;
  readonly #checkpointsEnabled: boolean;
  readonly #port: MessagePort;
  readonly #checkpointWaiters = new Map<string, PendingCheckpoint>();
  #queue: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: RpcRouterOptions) {
    this.#runtime = options.runtime;
    this.#checkpointsEnabled = options.checkpointsEnabled;
    this.#port = options.port;
    this.#port.on("message", (message: unknown) => {
      this.#onMessage(message);
    });
    this.#port.on("messageerror", (error: Error) => {
      this.#failAllCheckpoints(error);
    });
  }

  close(): void {
    this.#closed = true;
    this.#failAllCheckpoints(new Error("router closed"));
  }

  #onMessage(message: unknown): void {
    if (isCheckpointRelease(message)) {
      const waiter = this.#checkpointWaiters.get(message.requestId);
      if (waiter !== undefined) {
        this.#checkpointWaiters.delete(message.requestId);
        clearTimeout(waiter.timeout);
        waiter.settle({ proceed: message.proceed });
      }
      return;
    }
    // 串行排队：后端单连接 SQLite，事务不交错。
    this.#queue = this.#queue.then(
      () => this.#handleRequest(message),
      () => this.#handleRequest(message),
    );
  }

  async #handleRequest(message: unknown): Promise<void> {
    if (this.#closed) {
      return;
    }
    const parsed = PersistenceRpcRequestSchema.safeParse(message);
    if (!parsed.success) {
      // 无法关联合法 requestId 的消息只能丢弃；细节进 stderr 供 CI 捕获。
      console.error("[persistence-worker] dropped malformed rpc message");
      return;
    }
    const request = parsed.data;
    if (!isPersistenceOperation(request.operation)) {
      this.#respond(request.requestId, {
        code: "invalid_request",
        message: "unknown operation",
        retryable: false,
      });
      return;
    }
    const operation = request.operation;
    const context: OperationContext = {
      trace: request.trace,
      notifyCheckpoint: this.#checkpointsEnabled
        ? (checkpoint, checkpointContext) =>
            this.#notifyCheckpoint(request.requestId, checkpoint, checkpointContext)
        : null,
      deadlineUs: request.deadlineUs === undefined ? null : parseDecimalString(request.deadlineUs),
    };
    try {
      const { input } = decodeOperationPayload(operation, request.payload);
      const resultMessage = await this.#runtime.execute(operation, input, context);
      // Node MessagePort.postMessage 没有 targetOrigin（浏览器规则误报）。
      this.#port.postMessage({
        version: 1,
        requestId: request.requestId,
        ok: true,
        payload: encodeOperationResult(resultMessage),
      });
    } catch (error) {
      const safe = mapSqliteError(error);
      if (safe.code === "internal") {
        console.error("[persistence-worker] operation failed:", error);
      }
      this.#respond(request.requestId, safe);
    }
  }

  #respond(requestId: string, error: SafePersistenceError): void {
    this.#port.postMessage({
      version: 1,
      requestId,
      ok: false,
      error,
    });
  }

  #notifyCheckpoint(
    requestId: string,
    checkpoint: "before_scene_transaction_commit",
    context: { traceId: string; sceneId?: string; outboxId?: string },
  ): Promise<void> {
    const notice = PersistenceCheckpointNoticeSchema.parse({
      type: "persistence_checkpoint",
      version: 1,
      requestId,
      checkpoint,
      context,
    });
    this.#port.postMessage(notice);
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#checkpointWaiters.delete(requestId);
        reject(new PersistenceError("deadline_exceeded", "checkpoint release timed out"));
      }, CHECKPOINT_WAIT_TIMEOUT_MS);
      this.#checkpointWaiters.set(requestId, {
        settle: (outcome) => {
          clearTimeout(timeout);
          if ("proceed" in outcome && outcome.proceed) {
            resolve();
            return;
          }
          if ("fail" in outcome) {
            reject(
              new PersistenceError("unavailable", "checkpoint channel failed", {
                cause: outcome.fail,
              }),
            );
            return;
          }
          reject(new PersistenceError("checkpoint_aborted", "checkpoint observer aborted"));
        },
        timeout,
      });
    });
  }

  #failAllCheckpoints(error: Error): void {
    for (const [requestId, waiter] of this.#checkpointWaiters) {
      clearTimeout(waiter.timeout);
      this.#checkpointWaiters.delete(requestId);
      waiter.settle({ fail: error });
    }
  }
}

export function startRouter(options: Omit<RpcRouterOptions, "port">): PersistenceRpcRouter {
  const port = parentPort;
  if (port === null) {
    throw new Error("persistence worker requires a parent message port");
  }
  return new PersistenceRpcRouter({ ...options, port });
}
