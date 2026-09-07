import type {
  HistoryRecoveryInput,
  HistoryRecoveryState,
} from "../repositories/phase4-history-inventory.js";
import type { MemoryRecallRequest } from "@bellis/contracts";
import type {
  HistoryVerificationBatch,
  HistoryVerificationPage,
} from "../repositories/phase4-history-verification.js";
import type { RecallRequestWrite } from "../repositories/phase4-recall-requests.js";
import type {
  HistoryInventoryBegin,
  HistoryInventory,
  HistoryInventoryPageInput,
  HistoryInventoryPage,
  HistoryInventoryItemInput,
  HistoryInventoryItem,
} from "../repositories/phase4-history-inventory.js";
import type { MemoryHistoryGap } from "@bellis/contracts";
import { diskAdmissionOptions } from "../disk-admission.js";
import type { MemoryResourceInvalidation } from "@bellis/contracts";
import type { LocalInputVisibilityRequest, LocalInputVisibility } from "@bellis/contracts";
import type {
  MemoryForgetReceipt,
  MemoryForgetOperation,
  MemoryForgetTransition,
} from "@bellis/contracts";
import type {
  EffectPreparation,
  AudioSegmentBinding,
  StageEffectAck,
  MemoryPolicyStamp,
  MemoryPolicyChange,
  MemoryPolicySnapshot,
} from "@bellis/contracts";
import type { ConfirmEffectInput, ConfirmedSpeech } from "../repositories/phase4-effects.js";
import type {
  ProviderStateScope,
  ProviderStateWrite,
  ProviderStateSnapshot,
} from "../repositories/phase4-provider-state.js";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type {
  IngestedSignal,
  ContextAdoption,
  ContextManifest,
  OutboxMessage,
  Scene,
  ScenePlan,
  SessionRecord,
  Signal,
  TraceContext,
} from "@bellis/contracts";
import { createNoopLogger } from "@bellis/observability";
import type { LoggerPort } from "@bellis/observability";
import type {
  PersistenceCheckpoint,
  PersistenceCheckpointObserver,
} from "../checkpoints/observer.js";
import type { MigrationDefinition } from "../migrations/definition.js";
import { PersistenceError } from "../errors.js";
import type { PersistenceErrorCode, SafePersistenceError } from "../errors.js";
import { PersistenceRpcChannel } from "./rpc-channel.js";

/**
 * Persistence 公开装配接口（docs/phase-1-reference.md）。
 *
 * Gate 1.1 审查结论（docs/phase-1-reference.md）：
 * - 新增 `ensureSession`：commitScene 依赖 Session 存在，此前无创建入口。
 * - `CommitSceneInput` 新增 `scene`：scenes.payload_json 必须写入经
 *   SceneSchema 验证的完整版本化 Payload，不再只有 ID。
 * - 新增 `advanceServerSeq`：RecoveryState.latestServerSeq 的单调推进方法。
 * - `CompleteOutboxInput`/`RetryOutboxInput` 新增 `ownerInstanceId`：
 *   Outbox 状态转换必须是条件更新，避免两个 Dispatcher 抢同一项。
 * - 新增 `listRecords`：按 Session/Trace/Aggregate 的索引查询。
 * 以上均为兼容新增，无破坏性修改，不触碰 @bellis/contracts。
 */

export interface EnsureSessionInput {
  readonly sessionId: string;
  readonly createdAtMs: number;
  readonly trace: TraceContext;
}

export interface AppendRecordInput {
  readonly record: SessionRecord;
  readonly trace: TraceContext;
}

export interface CommitSceneInput {
  readonly sceneId: string;
  readonly cycleId: string;
  readonly sessionId: string;
  /** 完整版本化 Scene Payload；Worker 验证 sceneId/cycleId 一致后写入 scenes.payload_json。 */
  readonly scene: Scene;
  /** Phase 2 兼容新增：完整编译计划写入 scenes.plan_json（Migration 0002）。 */
  readonly plan?: ScenePlan;
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

/**
 * 活动 Scene 索引行（scene-execution.md §8 对账视图来源）。
 * durable = scenes 表存在已提交行（committing 歧义的裁决证据）；
 * durableCycleId = 该已提交行的 cycle_id（unknown 行的 cycleId 回退）。
 */
export interface ActiveSceneRow {
  readonly sceneId: string;
  readonly cycleId: string | null;
  readonly state: string;
  readonly updatedAtMs: number;
  readonly durable: boolean;
  readonly durableCycleId: string | null;
}

export interface AdvanceServerSeqInput {
  readonly sessionId: string;
  readonly latestServerSeq: bigint;
  readonly trace: TraceContext;
}

export interface ListRecordsInput {
  readonly sessionId?: string;
  readonly traceId?: string;
  readonly aggregateId?: string;
  /** 按 recordType 过滤（如 scene_lifecycle 专用窗口）。 */
  readonly recordType?: string;
  /** 排序方向（默认 asc；desc 取最近窗口）。 */
  readonly order?: "asc" | "desc";
  readonly limit?: number;
}

export interface ClaimOutboxInput {
  readonly limit: number;
  readonly leaseMs: number;
  readonly ownerInstanceId: string;
}

export interface CompleteOutboxInput {
  readonly outboxId: string;
  /** 条件更新：只有当前 Lease 持有者才能标记 delivered。 */
  readonly ownerInstanceId: string;
}

export interface RetryOutboxInput {
  readonly outboxId: string;
  /** 条件更新：只有当前 Lease 持有者才能触发重试或 Dead Letter。 */
  readonly ownerInstanceId: string;
  readonly errorCode: string;
  readonly retryable: boolean;
}

export interface OutboxStats {
  readonly pending: number;
  readonly inFlight: number;
  readonly delivered: number;
  readonly dead: number;
}

/** retryOutbox 的落库结果：退避重试或进入 Dead Letter。 */
export interface OutboxRetryDisposition {
  readonly disposition: "retry" | "dead";
}

export interface Phase3AppendSignalInput {
  readonly policy?: MemoryPolicyStamp;
  readonly observations?: readonly import("@bellis/contracts").MemoryInputObservation[];
  readonly sessionId: string;
  readonly signal: Signal;
  readonly priorityClass: "normal" | "urgent";
  readonly receivedAtMs: number;
  readonly normalCapacity: number;
  readonly urgentCapacity: number;
}

export type Phase3AppendSignalOutcome =
  | { readonly result: "accepted" | "deduplicated"; readonly sequence: bigint }
  | { readonly result: "rejected"; readonly reason: "normal_capacity" | "urgent_capacity" };

export interface Phase3RestoreState {
  readonly pending: readonly IngestedSignal[];
  readonly lastAssigned: bigint;
  readonly consumed: bigint;
}

export interface Phase3AdoptCycleInput {
  readonly context?: ContextAdoption;
  readonly sessionId: string;
  readonly turnId: string;
  readonly cycleId: string;
  readonly cycleIndex: number;
  readonly batchId: string;
  readonly watermarkFrom: bigint;
  readonly watermarkTo: bigint;
  readonly next: "finish" | "after_tools" | "continue";
  readonly degraded: boolean;
  readonly packetDigest: string;
  readonly toolRuns: readonly {
    readonly toolRunId: string;
    readonly toolName: string;
    readonly idempotencyKeyHash: string | null;
    readonly originalCall?: import("@bellis/contracts").ToolCall | undefined;
  }[];
}

export interface Phase3ToolRunEventInput {
  readonly sessionId: string;
  readonly toolRunId: string;
  readonly cycleId: string;
  readonly toolName: string;
  readonly transition: "started" | "finished";
  readonly state: string;
  readonly durationMs?: number | null;
  readonly errorCode?: string | null;
  readonly cacheSource?: string | null;
  readonly resultSummary?: unknown;
}

export interface Phase3DecisionState {
  readonly consumed: bigint;
  readonly cycles: readonly {
    readonly cycleId: string;
    readonly turnId: string;
    readonly cycleIndex: number;
    readonly watermarkTo: bigint;
    readonly degraded: boolean;
    readonly next: string;
  }[];
  readonly toolRuns: readonly {
    readonly toolRunId: string;
    readonly cycleId: string;
    readonly toolName: string;
    readonly state: string;
    readonly idempotencyKeyHash: string | null;
    readonly cacheSource: string | null;
    readonly errorCode: string | null;
  }[];
  readonly uncertainMarked: number;
}

export interface Phase3ToolCacheSetInput {
  readonly cacheKey: string;
  readonly toolName: string;
  readonly payload: unknown;
  readonly ttlMs: number;
}

export interface PersistenceClient {
  readDiskStatus(
    signal?: AbortSignal,
  ): Promise<import("../disk-admission.js").PersistenceDiskStatus>;
  phase4EnsureMemoryPolicy(
    scopeKey: string,
    privacyRevision: string,
    sessionId?: string,
  ): Promise<MemoryPolicySnapshot>;
  phase4ReadMemoryPolicy(scopeKey: string): Promise<MemoryPolicySnapshot>;
  phase4ChangeMemoryPolicy(input: MemoryPolicyChange): Promise<MemoryPolicySnapshot>;
  phase4BeginMemoryForget(sessionId: string, toolRunId: string): Promise<MemoryForgetTransition>;
  phase4CompleteMemoryForget(input: {
    sessionId: string;
    toolRunId: string;
    receipt: MemoryForgetReceipt;
  }): Promise<MemoryForgetTransition>;
  phase4ReadMemoryForget(
    sessionId: string,
    toolRunId: string,
  ): Promise<MemoryForgetOperation | null>;
  phase4BeginHistoryGap(scopeKey: string, gap: MemoryHistoryGap): Promise<MemoryPolicySnapshot>;
  phase4ApplyResourceInvalidation(
    scopeKey: string,
    event: MemoryResourceInvalidation,
  ): Promise<MemoryPolicySnapshot>;
  phase4ReadLocalVisibility(
    input: LocalInputVisibilityRequest,
    signal?: AbortSignal,
  ): Promise<LocalInputVisibility>;
  phase4ReadPreparedTool(
    sessionId: string,
    toolRunId: string,
  ): Promise<import("@bellis/contracts").PreparedToolCall | null>;
  phase4SavePreparedTool(input: import("@bellis/contracts").PreparedToolCall): Promise<void>;
  phase4ReadToolCall(
    sessionId: string,
    toolRunId: string,
  ): Promise<import("@bellis/contracts").ToolCall | null>;
  phase4ReadProviderState(scope: ProviderStateScope): Promise<ProviderStateSnapshot | null>;
  phase4WriteProviderState(input: ProviderStateWrite): Promise<number>;
  phase4ReadHistoryRecoveryState(input: HistoryRecoveryInput): Promise<HistoryRecoveryState>;
  phase4ReadRevalidationRequest(
    input: HistoryInventoryItemInput,
  ): Promise<MemoryRecallRequest | null>;
  phase4RecordHistoryVerification(input: HistoryVerificationBatch): Promise<void>;
  phase4ReadHistoryVerificationPage(
    input: HistoryInventoryPageInput,
  ): Promise<HistoryVerificationPage>;
  phase4BeginHistoryInventory(input: HistoryInventoryBegin): Promise<HistoryInventory>;
  phase4RecordRecallRequest(input: RecallRequestWrite): Promise<void>;
  phase4ReadHistoryInventoryPage(input: HistoryInventoryPageInput): Promise<HistoryInventoryPage>;
  phase4ReadHistoryInventoryItem(input: HistoryInventoryItemInput): Promise<HistoryInventoryItem>;

  phase4PrepareEffects(input: EffectPreparation): Promise<void>;
  phase4BindAudioSegment(input: AudioSegmentBinding): Promise<void>;
  phase4ConfirmEffect(input: ConfirmEffectInput): Promise<StageEffectAck>;
  phase4CloseEffects(sessionId: string, sceneId: string): Promise<void>;
  phase4ReadConfirmedSpeech(
    sessionId: string,
    limit?: number,
    policy?: MemoryPolicyStamp,
  ): Promise<readonly ConfirmedSpeech[]>;
  phase4ReadContextManifest(
    sessionId: string,
    cycleId: string,
  ): Promise<{ manifest: ContextManifest; manifestDigest: string } | null>;
  migrate(signal?: AbortSignal): Promise<void>;
  ensureSession(input: EnsureSessionInput): Promise<void>;
  appendRecord(input: AppendRecordInput): Promise<SessionRecord>;
  commitScene(input: CommitSceneInput): Promise<CommitSceneResult>;
  advanceServerSeq(input: AdvanceServerSeqInput): Promise<bigint>;
  readRecoveryState(sessionId: string): Promise<RecoveryState>;
  listRecords(input: ListRecordsInput): Promise<SessionRecord[]>;
  /** 活动 Scene 索引查询（跨进程恢复对账的权威来源）。 */
  listActiveScenes(sessionId: string): Promise<readonly ActiveSceneRow[]>;
  claimOutbox(input: ClaimOutboxInput): Promise<OutboxMessage[]>;
  completeOutbox(input: CompleteOutboxInput): Promise<void>;
  retryOutbox(input: RetryOutboxInput): Promise<OutboxRetryDisposition>;
  readOutboxStats(): Promise<OutboxStats>;
  /** Phase 3（ADR 0004）：Signal 入库（事务内分配序号 + 去重）。 */
  phase3AppendSignal(
    input: Phase3AppendSignalInput & { readonly trace: TraceContext },
  ): Promise<Phase3AppendSignalOutcome>;
  phase3RestoreSignals(sessionId: string): Promise<Phase3RestoreState>;
  phase3AdoptCycle(input: Phase3AdoptCycleInput & { readonly trace: TraceContext }): Promise<void>;
  phase3ToolRunEvent(
    input: Phase3ToolRunEventInput & { readonly trace: TraceContext },
  ): Promise<void>;
  phase3ReadDecisionState(
    sessionId: string,
    options?: { readonly markUncertain?: boolean },
  ): Promise<Phase3DecisionState>;
  phase3ToolCacheGet(cacheKey: string): Promise<unknown>;
  phase3ToolCacheSet(input: Phase3ToolCacheSetInput): Promise<void>;
  close(): Promise<void>;
}

/** Worker 入口注入：默认指向包产物；测试指向 TS 源码并注入解析 hook。 */
export interface PersistenceWorkerOptions {
  readonly url?: URL | string;
  readonly execArgv?: readonly string[];
}

/** Outbox 重试策略（Worker 内执行退避；抖动由种子确定性导出）。 */
export interface OutboxRetryPolicyConfig {
  /** 首次重试基准延迟（毫秒）。 */
  readonly baseMs: number;
  /** 退避上限（毫秒）。 */
  readonly maxMs: number;
  /** 超过该尝试次数进入 dead。 */
  readonly maxAttempts: number;
  /** 抖动种子；相同种子 + 尝试次数得到相同抖动（可重放测试）。 */
  readonly jitterSeed?: number;
}

export interface PersistenceMigrationsOverride {
  readonly state?: readonly MigrationDefinition[];
  readonly telemetry?: readonly MigrationDefinition[];
}

export interface PersistenceClientOptions {
  /** 数据目录绝对路径；由调用方显式传入，没有仓库内默认值。 */
  readonly dataDirectory: string;
  /** 单请求默认 Deadline（毫秒），默认 10_000。 */
  readonly defaultDeadlineMs?: number;
  readonly diskAdmission?: import("../disk-admission.js").PersistenceDiskAdmissionOptions;
  readonly worker?: PersistenceWorkerOptions;
  /** 受控检查点观察器；生产留空（No-op）。 */
  readonly checkpointObserver?: PersistenceCheckpointObserver;
  /** Outbox 重试策略；缺省 baseMs=100、maxMs=30_000、maxAttempts=8。 */
  readonly retryPolicy?: OutboxRetryPolicyConfig;
  /** 预置 recordId 序列（测试注入，按序消耗，耗尽后回退 randomUUID）。 */
  readonly recordIds?: readonly string[];
  /** 固定审计墙钟（epoch ms，测试注入；不参与恢复排序与 Lease 判断）。 */
  readonly wallClockMs?: number;
  readonly logger?: LoggerPort;
}

/**
 * @internal 仅供包内测试装配：注入 Migration 注册表（含任意 SQL 文本）。
 * 不从包根导出（package.json exports 只暴露 "."），外部消费者无法触达，
 * 公开 PersistenceClientOptions 不存在任何 SQL 通道（评审项 5）。
 */
export interface InternalPersistenceTestOverrides {
  readonly migrations?: PersistenceMigrationsOverride;
}

/** RPC 通道诊断事件（测试用；不进入生产日志必选字段）。 */
export interface PersistenceRpcDiagnostic {
  readonly kind: "late_response_dropped" | "unknown_response_dropped";
  readonly requestId: string;
  readonly code: PersistenceErrorCode;
  readonly safe: SafePersistenceError;
}

const DEFAULT_DEADLINE_MS = 10_000;

function internalTrace(): TraceContext {
  return { traceId: randomUUID().replaceAll("-", "") };
}

function resolveWorkerUrl(url: URL | string): URL {
  if (url instanceof URL) {
    return url;
  }
  if (url.startsWith("file:")) {
    return new URL(url);
  }
  if (!isAbsolute(url)) {
    throw new PersistenceError("invalid_request", "worker url must be absolute or a file URL");
  }
  return pathToFileURL(url);
}

/** 公开装配工厂：创建绑定 DB Worker 的 PersistenceClient。 */
export function createPersistenceClient(options: PersistenceClientOptions): PersistenceClient {
  // overrides 恒为空对象：实现只从第二个参数读取 migrations，
  // 调用方即使通过 JS 附加属性或 TS 强转向 options 塞入 migrations
  // 也会被忽略——公开入口不存在任何 SQL 通道（评审残留 1）。
  return createPersistenceClientForTesting(options, {});
}

/** @internal 测试装配入口：额外允许注入 Migration 注册表（不从包根导出）。 */
export function createPersistenceClientForTesting(
  options: PersistenceClientOptions,
  overrides: InternalPersistenceTestOverrides = {},
): PersistenceClient {
  if (!isAbsolute(options.dataDirectory)) {
    throw new PersistenceError(
      "invalid_request",
      "dataDirectory must be an absolute path; there is no repository-local default",
    );
  }
  diskAdmissionOptions(options.diskAdmission);
  const logger = options.logger ?? createNoopLogger();
  const defaultDeadlineMs = options.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS;
  const workerUrl = resolveWorkerUrl(
    options.worker?.url ?? new URL("../worker/entry.js", import.meta.url),
  );
  const observer = options.checkpointObserver;
  const channel = new PersistenceRpcChannel({
    workerUrl,
    execArgv: options.worker?.execArgv,
    workerData: {
      dataDirectory: options.dataDirectory,
      diskAdmission: options.diskAdmission,
      checkpointsEnabled: observer !== undefined,
      // migrations 只来自 overrides（包内测试装配第二参数）；
      // options 上的任何未知属性都不会进入 workerData。
      stateMigrations: overrides.migrations?.state,
      telemetryMigrations: overrides.migrations?.telemetry,
      retryPolicy: options.retryPolicy,
      wallClockMs: options.wallClockMs,
      recordIds: options.recordIds,
    },
    defaultDeadlineMs,
    logger,
    onCheckpointNotice: observer
      ? (notice) =>
          observer.reached(
            notice.checkpoint as PersistenceCheckpoint,
            {
              traceId: notice.context.traceId,
              ...(notice.context.sceneId === undefined ? {} : { sceneId: notice.context.sceneId }),
              ...(notice.context.outboxId === undefined
                ? {}
                : { outboxId: notice.context.outboxId }),
            },
            notice.signal,
          )
      : undefined,
  });
  let migrated = false;

  const requireMigrated = (): void => {
    if (!migrated) {
      throw new PersistenceError("not_migrated", "migrate() must run before business operations");
    }
  };

  return {
    async migrate(signal?: AbortSignal): Promise<void> {
      await channel.call<"migrate">({ operation: "migrate", input: undefined }, internalTrace(), {
        signal,
      });
      migrated = true;
    },
    async ensureSession(input: EnsureSessionInput): Promise<void> {
      requireMigrated();
      await channel.call<"ensure_session">(
        {
          operation: "ensure_session",
          input: { sessionId: input.sessionId, createdAtMs: input.createdAtMs },
        },
        input.trace,
      );
    },
    async appendRecord(input: AppendRecordInput): Promise<SessionRecord> {
      requireMigrated();
      const result = await channel.call<"append_record">(
        { operation: "append_record", input: { record: input.record } },
        input.trace,
      );
      return result.record as SessionRecord;
    },
    async commitScene(input: CommitSceneInput): Promise<CommitSceneResult> {
      requireMigrated();
      const { trace: _trace, ...payload } = input;
      const result = await channel.call<"commit_scene">(
        { operation: "commit_scene", input: payload },
        input.trace,
      );
      return result;
    },
    async advanceServerSeq(input: AdvanceServerSeqInput): Promise<bigint> {
      requireMigrated();
      const result = await channel.call<"advance_server_seq">(
        {
          operation: "advance_server_seq",
          input: { sessionId: input.sessionId, latestServerSeq: input.latestServerSeq },
        },
        input.trace,
      );
      return result.latestServerSeq;
    },
    async readRecoveryState(sessionId: string): Promise<RecoveryState> {
      requireMigrated();
      const result = await channel.call<"read_recovery_state">(
        { operation: "read_recovery_state", input: { sessionId } },
        internalTrace(),
      );
      return result;
    },
    async listActiveScenes(sessionId: string): Promise<readonly ActiveSceneRow[]> {
      requireMigrated();
      const result = await channel.call<"list_active_scenes">(
        {
          operation: "list_active_scenes",
          input: { sessionId },
        },
        internalTrace(),
      );
      return result.scenes as ActiveSceneRow[];
    },
    async listRecords(input: ListRecordsInput): Promise<SessionRecord[]> {
      requireMigrated();
      const result = await channel.call<"list_records">(
        {
          operation: "list_records",
          input: {
            ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
            ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
            ...(input.aggregateId === undefined ? {} : { aggregateId: input.aggregateId }),
            ...(input.recordType === undefined ? {} : { recordType: input.recordType }),
            ...(input.order === undefined ? {} : { order: input.order }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          },
        },
        internalTrace(),
      );
      return result.records as SessionRecord[];
    },
    async claimOutbox(input: ClaimOutboxInput): Promise<OutboxMessage[]> {
      requireMigrated();
      const result = await channel.call<"claim_outbox">(
        {
          operation: "claim_outbox",
          input: {
            limit: input.limit,
            leaseMs: input.leaseMs,
            ownerInstanceId: input.ownerInstanceId,
          },
        },
        internalTrace(),
      );
      return result.messages as OutboxMessage[];
    },
    async completeOutbox(input: CompleteOutboxInput): Promise<void> {
      requireMigrated();
      await channel.call<"complete_outbox">(
        {
          operation: "complete_outbox",
          input: {
            outboxId: input.outboxId,
            ownerInstanceId: input.ownerInstanceId,
          },
        },
        internalTrace(),
      );
    },
    async retryOutbox(input: RetryOutboxInput): Promise<OutboxRetryDisposition> {
      requireMigrated();
      const result = await channel.call<"retry_outbox">(
        {
          operation: "retry_outbox",
          input: {
            outboxId: input.outboxId,
            ownerInstanceId: input.ownerInstanceId,
            errorCode: input.errorCode,
            retryable: input.retryable,
          },
        },
        internalTrace(),
      );
      return result;
    },
    async readOutboxStats(): Promise<OutboxStats> {
      requireMigrated();
      const result = await channel.call<"read_outbox_stats">(
        { operation: "read_outbox_stats", input: undefined },
        internalTrace(),
      );
      return result;
    },
    async phase3AppendSignal(
      input: Phase3AppendSignalInput & { readonly trace: TraceContext },
    ): Promise<Phase3AppendSignalOutcome> {
      requireMigrated();
      const { trace: _trace, ...payload } = input;
      return channel.call<"phase3_append_signal">(
        { operation: "phase3_append_signal", input: payload },
        input.trace,
      );
    },
    async phase3RestoreSignals(sessionId: string): Promise<Phase3RestoreState> {
      requireMigrated();
      return channel.call<"phase3_restore_signals">(
        { operation: "phase3_restore_signals", input: { sessionId } },
        internalTrace(),
      );
    },
    async phase4PrepareEffects(input) {
      requireMigrated();
      await channel.call<"phase4_prepare_effects">(
        { operation: "phase4_prepare_effects", input },
        internalTrace(),
      );
    },
    async phase4BeginMemoryForget(sessionId, toolRunId) {
      requireMigrated();
      return channel.call<"phase4_begin_memory_forget">(
        { operation: "phase4_begin_memory_forget", input: { sessionId, toolRunId } },
        internalTrace(),
      );
    },
    async phase4CompleteMemoryForget(input) {
      requireMigrated();
      return channel.call<"phase4_complete_memory_forget">(
        { operation: "phase4_complete_memory_forget", input },
        internalTrace(),
      );
    },
    async phase4ReadMemoryForget(sessionId, toolRunId) {
      requireMigrated();
      return channel.call<"phase4_read_memory_forget">(
        { operation: "phase4_read_memory_forget", input: { sessionId, toolRunId } },
        internalTrace(),
      );
    },
    async phase4ReadHistoryRecoveryState(input) {
      requireMigrated();
      return channel.call<"phase4_read_history_recovery_state">(
        { operation: "phase4_read_history_recovery_state", input },
        internalTrace(),
      );
    },
    async phase4ReadRevalidationRequest(input) {
      requireMigrated();
      return channel.call<"phase4_read_revalidation_request">(
        { operation: "phase4_read_revalidation_request", input },
        internalTrace(),
      );
    },
    async phase4RecordHistoryVerification(input) {
      requireMigrated();
      return channel.call<"phase4_record_history_verification">(
        { operation: "phase4_record_history_verification", input },
        internalTrace(),
      );
    },
    async phase4ReadHistoryVerificationPage(input) {
      requireMigrated();
      return channel.call<"phase4_read_history_verification_page">(
        { operation: "phase4_read_history_verification_page", input },
        internalTrace(),
      );
    },
    async phase4BeginHistoryInventory(input) {
      requireMigrated();
      return channel.call<"phase4_begin_history_inventory">(
        { operation: "phase4_begin_history_inventory", input },
        internalTrace(),
      );
    },
    async phase4RecordRecallRequest(input) {
      requireMigrated();
      return channel.call<"phase4_record_recall_request">(
        { operation: "phase4_record_recall_request", input },
        internalTrace(),
      );
    },
    async phase4ReadHistoryInventoryPage(input) {
      requireMigrated();
      return channel.call<"phase4_read_history_inventory_page">(
        { operation: "phase4_read_history_inventory_page", input },
        internalTrace(),
      );
    },
    async phase4ReadHistoryInventoryItem(input) {
      requireMigrated();
      return channel.call<"phase4_read_history_inventory_item">(
        { operation: "phase4_read_history_inventory_item", input },
        internalTrace(),
      );
    },
    async phase4BeginHistoryGap(scopeKey, gap) {
      requireMigrated();
      return channel.call<"phase4_begin_history_gap">(
        { operation: "phase4_begin_history_gap", input: { scopeKey, gap } },
        internalTrace(),
      );
    },
    async phase4ApplyResourceInvalidation(scopeKey, event) {
      requireMigrated();
      return channel.call<"phase4_apply_resource_invalidation">(
        { operation: "phase4_apply_resource_invalidation", input: { scopeKey, event } },
        internalTrace(),
      );
    },
    async phase4ReadLocalVisibility(input, signal) {
      requireMigrated();
      return channel.call<"phase4_read_local_visibility">(
        { operation: "phase4_read_local_visibility", input },
        internalTrace(),
        { signal },
      );
    },
    async phase4ReadPreparedTool(sessionId, toolRunId) {
      requireMigrated();
      return channel.call<"phase4_read_prepared_tool">(
        { operation: "phase4_read_prepared_tool", input: { sessionId, toolRunId } },
        internalTrace(),
      );
    },
    async phase4SavePreparedTool(input) {
      requireMigrated();
      await channel.call<"phase4_save_prepared_tool">(
        { operation: "phase4_save_prepared_tool", input },
        internalTrace(),
      );
    },
    async phase4ReadToolCall(sessionId, toolRunId) {
      requireMigrated();
      return channel.call<"phase4_read_tool_call">(
        { operation: "phase4_read_tool_call", input: { sessionId, toolRunId } },
        internalTrace(),
      );
    },
    async phase4ReadProviderState(input) {
      requireMigrated();
      return channel.call<"phase4_read_provider_state">(
        { operation: "phase4_read_provider_state", input },
        internalTrace(),
      );
    },
    async readDiskStatus(signal) {
      requireMigrated();
      return channel.call<"read_disk_status">(
        { operation: "read_disk_status", input: undefined },
        internalTrace(),
        { signal },
      );
    },
    async phase4EnsureMemoryPolicy(scopeKey, privacyRevision, sessionId) {
      requireMigrated();
      return channel.call<"phase4_ensure_memory_policy">(
        {
          operation: "phase4_ensure_memory_policy",
          input: { scopeKey, privacyRevision, ...(sessionId === undefined ? {} : { sessionId }) },
        },
        internalTrace(),
      );
    },
    async phase4ReadMemoryPolicy(scopeKey) {
      requireMigrated();
      return channel.call<"phase4_read_memory_policy">(
        { operation: "phase4_read_memory_policy", input: { scopeKey } },
        internalTrace(),
      );
    },
    async phase4ChangeMemoryPolicy(input) {
      requireMigrated();
      return channel.call<"phase4_change_memory_policy">(
        { operation: "phase4_change_memory_policy", input },
        internalTrace(),
      );
    },
    async phase4WriteProviderState(input) {
      requireMigrated();
      return channel.call<"phase4_write_provider_state">(
        { operation: "phase4_write_provider_state", input },
        internalTrace(),
      );
    },
    async phase4BindAudioSegment(input) {
      requireMigrated();
      await channel.call<"phase4_bind_audio_segment">(
        { operation: "phase4_bind_audio_segment", input },
        internalTrace(),
      );
    },
    async phase4ConfirmEffect(input) {
      requireMigrated();
      return channel.call<"phase4_confirm_effect">(
        { operation: "phase4_confirm_effect", input },
        internalTrace(),
      );
    },
    async phase4CloseEffects(sessionId, sceneId) {
      requireMigrated();
      await channel.call<"phase4_close_effects">(
        { operation: "phase4_close_effects", input: { sessionId, sceneId } },
        internalTrace(),
      );
    },
    async phase4ReadConfirmedSpeech(sessionId, limit = 20, policy) {
      requireMigrated();
      const result = await channel.call<"phase4_read_confirmed_speech">(
        {
          operation: "phase4_read_confirmed_speech",
          input: { sessionId, limit, ...(policy === undefined ? {} : { policy }) },
        },
        internalTrace(),
      );
      return result.items;
    },
    async phase4ReadContextManifest(sessionId, cycleId) {
      requireMigrated();
      return channel.call<"phase4_read_context_manifest">(
        { operation: "phase4_read_context_manifest", input: { sessionId, cycleId } },
        internalTrace(),
      );
    },
    async phase3AdoptCycle(
      input: Phase3AdoptCycleInput & { readonly trace: TraceContext },
    ): Promise<void> {
      requireMigrated();
      const { trace: _trace, ...payload } = input;
      await channel.call<"phase3_adopt_cycle">(
        { operation: "phase3_adopt_cycle", input: payload },
        input.trace,
      );
    },
    async phase3ToolRunEvent(
      input: Phase3ToolRunEventInput & { readonly trace: TraceContext },
    ): Promise<void> {
      requireMigrated();
      const { trace: _trace, ...payload } = input;
      await channel.call<"phase3_tool_run_event">(
        {
          operation: "phase3_tool_run_event",
          input: {
            sessionId: payload.sessionId,
            toolRunId: payload.toolRunId,
            cycleId: payload.cycleId,
            toolName: payload.toolName,
            transition: payload.transition,
            state: payload.state,
            durationMs: payload.durationMs ?? null,
            errorCode: payload.errorCode ?? null,
            cacheSource: payload.cacheSource ?? null,
            resultSummary: payload.resultSummary ?? null,
          },
        },
        input.trace,
      );
    },
    async phase3ReadDecisionState(
      sessionId: string,
      query?: { readonly markUncertain?: boolean },
    ): Promise<Phase3DecisionState> {
      requireMigrated();
      return channel.call<"phase3_read_decision_state">(
        {
          operation: "phase3_read_decision_state",
          input: { sessionId, markUncertain: query?.markUncertain ?? false },
        },
        internalTrace(),
      );
    },
    async phase3ToolCacheGet(cacheKey: string): Promise<unknown> {
      requireMigrated();
      const result = await channel.call<"phase3_tool_cache_get">(
        { operation: "phase3_tool_cache_get", input: { cacheKey } },
        internalTrace(),
      );
      return result.payload;
    },
    async phase3ToolCacheSet(input: Phase3ToolCacheSetInput): Promise<void> {
      requireMigrated();
      await channel.call<"phase3_tool_cache_set">(
        { operation: "phase3_tool_cache_set", input },
        internalTrace(),
      );
    },
    async close(): Promise<void> {
      await channel.close(defaultDeadlineMs);
    },
  };
}
