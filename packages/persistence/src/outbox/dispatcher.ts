import type { OutboxMessage } from "@bellis/contracts";
import type { MonotonicClock } from "@bellis/contracts";
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
