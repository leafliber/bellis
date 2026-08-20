import type { OutboxMessage } from "@bellis/contracts";
import type { MonotonicClock } from "@bellis/contracts";
import { createNoopLogger, createNoopMetrics } from "@bellis/observability";
import type { LoggerPort, MetricsPort } from "@bellis/observability";
import type { PersistenceCheckpointObserver } from "../checkpoints/observer.js";
import type { PersistenceClient } from "../client/persistence-client.js";

/**
 * Outbox Dispatcher（P2 文档 §10）：至少一次交付状态机的客户端驱动侧。
 *
 * 状态机在 DB Worker 的 outbox 表内（pending → in_flight → delivered /
 * pending 重试 / dead）；Dispatcher 负责 Claim → Publish → Complete 的
 * 编排、检查点 2/3 的观察器回调、指标与优雅关闭。所有 Lease 判断和
 * 条件更新都在 Worker 内完成，主线程不直接触碰 SQLite。
 */

/** 发布结果：显式区分成功与（不可）重试失败，不靠异常类型猜测。 */
export type OutboxPublishResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errorCode: string; readonly retryable: boolean };

export type OutboxPublisher = (message: OutboxMessage) => Promise<OutboxPublishResult>;

export interface OutboxDispatcherOptions {
  readonly client: PersistenceClient;
  readonly publish: OutboxPublisher;
  /** 本 Dispatcher 实例标识；Lease 条件更新的持有者。 */
  readonly ownerInstanceId: string;
  readonly clock: MonotonicClock;
  /** 轮询间隔（毫秒），默认 100。 */
  readonly pollIntervalMs?: number;
  /** Claim 的 Lease 时长（毫秒），默认 5_000。 */
  readonly leaseMs?: number;
  /** 单批 Claim 上限，默认 32。 */
  readonly claimLimit?: number;
  /** 受控检查点观察器；生产留空（No-op）。 */
  readonly checkpointObserver?: PersistenceCheckpointObserver;
  readonly logger?: LoggerPort;
  readonly metrics?: MetricsPort;
}

export interface OutboxDispatchRunSummary {
  readonly claimed: number;
  readonly delivered: number;
  readonly retried: number;
  readonly dead: number;
}

/**
 * Dispatcher 公开接口：
 * - `runOnce()`：执行一次 Claim → Publish → Complete/Retry 批次（确定性测试入口）。
 * - `start()`：按 pollInterval 循环执行 runOnce。
 * - `stop()`：停止新 Claim，等待当前批次结束（Grace Period 语义）。
 */
export interface OutboxDispatcher {
  runOnce(): Promise<OutboxDispatchRunSummary>;
  start(): void;
  stop(): Promise<void>;
  readonly running: boolean;
}

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_LEASE_MS = 5_000;
const DEFAULT_CLAIM_LIMIT = 32;
const DISPATCHER_TRACE_ID = "outbox-dispatcher";

/** 创建 Outbox Dispatcher。publish 必须按 outboxId 幂等（至少一次交付）。 */
export function createOutboxDispatcher(options: OutboxDispatcherOptions): OutboxDispatcher {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const claimLimit = options.claimLimit ?? DEFAULT_CLAIM_LIMIT;
  const logger = options.logger ?? createNoopLogger();
  const metrics = options.metrics ?? createNoopMetrics();
  const checkpointObserver = options.checkpointObserver;
  const pendingGauge = metrics.gauge("bellis_outbox_pending");
  const deliveredCounter = metrics.counter("bellis_outbox_delivered_total");
  const retryCounter = metrics.counter("bellis_outbox_retry_total");
  const deadCounter = metrics.counter("bellis_outbox_dead_total");
  let running = false;
  let loop: Promise<void> | null = null;
  let sleepController: AbortController | null = null;

  async function reachCheckpoint(
    checkpoint: "after_scene_transaction_commit_before_outbox_dispatch",
  ): Promise<void>;
  async function reachCheckpoint(
    checkpoint: "after_outbox_publish_before_mark_delivered",
    context: { outboxId: string },
  ): Promise<void>;
  async function reachCheckpoint(
    checkpoint:
      | "after_scene_transaction_commit_before_outbox_dispatch"
      | "after_outbox_publish_before_mark_delivered",
    context?: { outboxId: string },
  ): Promise<void> {
    if (checkpointObserver === undefined) {
      return;
    }
    await checkpointObserver.reached(
      checkpoint,
      {
        traceId: DISPATCHER_TRACE_ID,
        ...(context === undefined ? {} : { outboxId: context.outboxId }),
      },
      new AbortController().signal,
    );
  }

  async function process(message: OutboxMessage): Promise<OutboxDispatchRunSummary> {
    let outcome: OutboxPublishResult;
    try {
      outcome = await options.publish(message);
    } catch (error) {
      logger.log("warn", "bellis_outbox_publish_threw", {
        outboxId: message.outboxId,
        error: error instanceof Error ? error.name : "unknown",
      });
      outcome = { ok: false, errorCode: "publisher_error", retryable: true };
    }
    if (!outcome.ok) {
      const { disposition } = await options.client.retryOutbox({
        outboxId: message.outboxId,
        ownerInstanceId: options.ownerInstanceId,
        errorCode: outcome.errorCode,
        retryable: outcome.retryable,
      });
      return disposition === "dead"
        ? { claimed: 0, delivered: 0, retried: 0, dead: 1 }
        : { claimed: 0, delivered: 0, retried: 1, dead: 0 };
    }
    await reachCheckpoint("after_outbox_publish_before_mark_delivered", {
      outboxId: message.outboxId,
    });
    await options.client.completeOutbox({
      outboxId: message.outboxId,
      ownerInstanceId: options.ownerInstanceId,
    });
    return { claimed: 0, delivered: 1, retried: 0, dead: 0 };
  }

  async function runOnce(): Promise<OutboxDispatchRunSummary> {
    await reachCheckpoint("after_scene_transaction_commit_before_outbox_dispatch");
    const claimed = await options.client.claimOutbox({
      limit: claimLimit,
      leaseMs,
      ownerInstanceId: options.ownerInstanceId,
    });
    const summary: {
      claimed: number;
      delivered: number;
      retried: number;
      dead: number;
    } = {
      claimed: claimed.length,
      delivered: 0,
      retried: 0,
      dead: 0,
    };
    for (const message of claimed) {
      const delta = await process(message);
      summary.delivered += delta.delivered;
      summary.retried += delta.retried;
      summary.dead += delta.dead;
    }
    const stats = await options.client.readOutboxStats();
    pendingGauge.set(stats.pending);
    deliveredCounter.inc(summary.delivered);
    retryCounter.inc(summary.retried);
    deadCounter.inc(summary.dead);
    return summary;
  }

  async function runLoop(): Promise<void> {
    for (;;) {
      if (!running) {
        break;
      }
      try {
        await runOnce();
      } catch (error) {
        logger.log("warn", "bellis_outbox_dispatch_failed", {
          error: error instanceof Error ? error.message : "unknown",
        });
      }
      if (!running) {
        break;
      }
      sleepController = new AbortController();
      try {
        await options.clock.sleepUntil(
          options.clock.nowUs() + BigInt(pollIntervalMs) * 1000n,
          sleepController.signal,
        );
      } catch {
        break;
      } finally {
        sleepController = null;
      }
    }
  }

  return {
    runOnce,
    start(): void {
      if (running) {
        return;
      }
      running = true;
      loop = runLoop();
    },
    async stop(): Promise<void> {
      running = false;
      sleepController?.abort();
      if (loop !== null) {
        await loop;
        loop = null;
      }
    },
    get running(): boolean {
      return running;
    },
  };
}
