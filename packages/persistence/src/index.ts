import type { OutboxMessage, SessionRecord, TraceContext } from "@bellis/contracts";

/**
 * @bellis/persistence — Gate 1 空壳。
 *
 * P2 将在此实现（phase-1-build-guide.md §13.3）：DB Worker 与类型化 RPC、
 * state.db/telemetry.db 与 Migration、原子 commitScene、Outbox 状态机、
 * PersistenceCheckpointObserver。`node:sqlite` 只能在 src/worker 内导入，
 * 主线程通过版本化 RPC 操作，不允许任意 SQL 穿过 Worker 边界。
 *
 * 空壳阶段只冻结公开 Port 形态（§9.1），不包含任何半成品实现。
 */

export interface AppendRecordInput {
  readonly record: SessionRecord;
  readonly trace: TraceContext;
}

export interface CommitSceneInput {
  readonly sceneId: string;
  readonly cycleId: string;
  readonly sessionId: string;
  readonly idempotencyKey: string;
  /** 请求摘要：同一幂等键携带不同摘要时返回冲突错误。 */
  readonly requestFingerprint: string;
  readonly watermarks: ReadonlyArray<{ source: string; watermark: bigint }>;
  readonly outbox: readonly OutboxMessage[];
  readonly trace: TraceContext;
}

export interface CommitSceneResult {
  readonly sceneId: string;
  readonly committedAtMs: number;
  readonly duplicate: boolean;
}

export interface RecoveryState {
  readonly sessionId: string;
  readonly latestServerSeq: bigint;
  readonly signalWatermarks: ReadonlyArray<{ source: string; watermark: bigint }>;
  readonly lastCommittedScene: {
    readonly sceneId: string;
    readonly cycleId: string;
    readonly committedAtMs: number;
  } | null;
}

export interface ClaimOutboxInput {
  readonly limit: number;
  readonly leaseMs: number;
  readonly ownerInstanceId: string;
}

export interface CompleteOutboxInput {
  readonly outboxId: string;
}

export interface RetryOutboxInput {
  readonly outboxId: string;
  readonly errorCode: string;
  readonly retryable: boolean;
}

/** Persistence 公开装配接口（phase-1-build-guide.md §9.1）。P2 提供实现。 */
export interface PersistenceClient {
  migrate(signal?: AbortSignal): Promise<void>;
  appendRecord(input: AppendRecordInput): Promise<SessionRecord>;
  commitScene(input: CommitSceneInput): Promise<CommitSceneResult>;
  readRecoveryState(sessionId: string): Promise<RecoveryState>;
  claimOutbox(input: ClaimOutboxInput): Promise<OutboxMessage[]>;
  completeOutbox(input: CompleteOutboxInput): Promise<void>;
  retryOutbox(input: RetryOutboxInput): Promise<void>;
  close(): Promise<void>;
}
