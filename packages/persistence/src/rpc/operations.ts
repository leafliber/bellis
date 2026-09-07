import {
  HistoryRecoveryInputSchema,
  HistoryRecoveryStateSchema,
  type HistoryRecoveryInput,
  type HistoryRecoveryState,
} from "../repositories/phase4-history-inventory.js";
import { MemoryRecallRequestSchema, type MemoryRecallRequest } from "@bellis/contracts";
import {
  HistoryVerificationBatchSchema,
  HistoryVerificationPageSchema,
  type HistoryVerificationBatch,
  type HistoryVerificationPage,
} from "../repositories/phase4-history-verification.js";
import {
  RecallRequestWriteSchema,
  type RecallRequestWrite,
} from "../repositories/phase4-recall-requests.js";
import {
  HistoryInventoryBeginSchema,
  HistoryInventorySchema,
  HistoryInventoryPageInputSchema,
  HistoryInventoryPageSchema,
  HistoryInventoryItemInputSchema,
  HistoryInventoryItemSchema,
  type HistoryInventoryBegin,
  type HistoryInventory,
  type HistoryInventoryPageInput,
  type HistoryInventoryPage,
  type HistoryInventoryItemInput,
  type HistoryInventoryItem,
} from "../repositories/phase4-history-inventory.js";
import { MemoryHistoryGapSchema, type MemoryHistoryGap } from "@bellis/contracts";
import { PersistenceDiskStatusSchema, type PersistenceDiskStatus } from "../disk-admission.js";
import {
  MemoryResourceInvalidationSchema,
  type MemoryResourceInvalidation,
} from "@bellis/contracts";
import {
  LocalInputVisibilityRequestSchema,
  LocalInputVisibilitySchema,
  type LocalInputVisibilityRequest,
  type LocalInputVisibility,
} from "@bellis/contracts";
import {
  MemoryForgetReceiptSchema,
  MemoryForgetOperationSchema,
  type MemoryForgetReceipt,
  type MemoryForgetOperation,
  type MemoryForgetTransition,
} from "@bellis/contracts";
import { PreparedToolCallSchema, type PreparedToolCall } from "@bellis/contracts";
import {
  EffectPreparationSchema,
  MemoryPolicyStampSchema,
  MemoryPolicyChangeSchema,
  MemoryPolicySnapshotSchema,
  type MemoryPolicyStamp,
  type MemoryPolicyChange,
  type MemoryPolicySnapshot,
  AudioSegmentBindingSchema,
  StageEffectReceiptSchema,
  StageEffectAckSchema,
  type EffectPreparation,
  type AudioSegmentBinding,
  type StageEffectAck,
} from "@bellis/contracts";
import type { ConfirmEffectInput, ConfirmedSpeech } from "../repositories/phase4-effects.js";
import type {
  ProviderStateScope,
  ProviderStateWrite,
  ProviderStateSnapshot,
} from "../repositories/phase4-provider-state.js";
import {
  MemoryInputObservationSchema,
  JsonValueSchema,
  type MemoryInputObservation,
  ContextAdoptionSchema,
  ContextManifestSchema,
  type ContextManifest,
  type ContextAdoption,
  DecimalStringSchema,
  IngestedSignalSchema,
  OutboxMessageSchema,
  ScenePlanSchema,
  SceneSchema,
  SessionRecordSchema,
  SignalSchema,
  SignalPriorityClassSchema,
  ToolRunStateSchema,
  ToolCallSchema,
  TraceIdSchema,
  UuidSchema,
  formatDecimalString,
  parseDecimalString,
} from "@bellis/contracts";
import type { IngestedSignal, OutboxMessage, Scene, ScenePlan, Signal } from "@bellis/contracts";
import type {
  CommitSceneResult,
  CompleteOutboxInput,
  OutboxStats,
  RecoveryState,
} from "../client/persistence-client.js";
import { PersistenceError } from "../errors.js";
import { z } from "zod";

/**
 * 闭合 Operation 集合与双向编解码（docs/protocols/persistence-and-recovery.md）。
 *
 * - 输入侧（Client→Worker）与结果侧（Worker→Client）都有显式 Schema，
 *   两侧校验；解码失败稳定报错，不执行任何 SQL。
 * - bigint（Watermark/Server Seq）只以规范十进制字符串过线，端点处经
 *   formatDecimalString/parseDecimalString 无损转换，绝不经过 number。
 * - trace 随 Envelope 传播，不进入 Payload。
 * - 编解码函数以可辨识联合消息为参数，switch 按 operation 收窄，
 *   全程无 any。
 */

export const PERSISTENCE_OPERATIONS = [
  "read_disk_status",
  "phase4_ensure_memory_policy",
  "phase4_read_memory_policy",
  "phase4_change_memory_policy",
  "phase4_read_provider_state",
  "phase4_read_tool_call",
  "phase4_read_prepared_tool",
  "phase4_read_local_visibility",
  "phase4_apply_resource_invalidation",
  "phase4_record_recall_request",
  "phase4_read_history_recovery_state",
  "phase4_read_revalidation_request",
  "phase4_record_history_verification",
  "phase4_read_history_verification_page",
  "phase4_begin_history_inventory",
  "phase4_read_history_inventory_page",
  "phase4_read_history_inventory_item",
  "phase4_begin_history_gap",
  "phase4_begin_memory_forget",
  "phase4_complete_memory_forget",
  "phase4_read_memory_forget",
  "phase4_save_prepared_tool",
  "phase4_write_provider_state",
  "phase4_prepare_effects",
  "phase4_bind_audio_segment",
  "phase4_confirm_effect",
  "phase4_close_effects",
  "phase4_read_confirmed_speech",

  "phase4_read_context_manifest",
  "ping",
  "migrate",
  "ensure_session",
  "append_record",
  "commit_scene",
  "advance_server_seq",
  "read_recovery_state",
  "list_records",
  "list_active_scenes",
  "claim_outbox",
  "complete_outbox",
  "retry_outbox",
  "read_outbox_stats",
  "phase3_append_signal",
  "phase3_restore_signals",
  "phase3_adopt_cycle",
  "phase3_tool_run_event",
  "phase3_read_decision_state",
  "phase3_tool_cache_get",
  "phase3_tool_cache_set",
] as const;

export type PersistenceOperation = (typeof PERSISTENCE_OPERATIONS)[number];

export function isPersistenceOperation(value: string): value is PersistenceOperation {
  return (PERSISTENCE_OPERATIONS as readonly string[]).includes(value);
}

const FingerprintSchema = z.string().min(1).max(256);
const WatermarkEntryJsonSchema = z.object({
  source: z.string().min(1).max(64),
  watermark: DecimalStringSchema,
});

export interface OperationInputs {
  readonly phase4_record_recall_request: RecallRequestWrite;
  readonly phase4_read_history_recovery_state: HistoryRecoveryInput;
  readonly phase4_read_revalidation_request: HistoryInventoryItemInput;
  readonly phase4_record_history_verification: HistoryVerificationBatch;
  readonly phase4_read_history_verification_page: HistoryInventoryPageInput;
  readonly phase4_begin_history_inventory: HistoryInventoryBegin;
  readonly phase4_read_history_inventory_page: HistoryInventoryPageInput;
  readonly phase4_read_history_inventory_item: HistoryInventoryItemInput;
  readonly phase4_begin_history_gap: { readonly scopeKey: string; readonly gap: MemoryHistoryGap };
  readonly phase4_apply_resource_invalidation: {
    readonly scopeKey: string;
    readonly event: MemoryResourceInvalidation;
  };
  readonly phase4_read_local_visibility: LocalInputVisibilityRequest;
  readonly phase4_read_prepared_tool: { readonly sessionId: string; readonly toolRunId: string };
  readonly phase4_begin_memory_forget: { readonly sessionId: string; readonly toolRunId: string };
  readonly phase4_complete_memory_forget: {
    readonly sessionId: string;
    readonly toolRunId: string;
    readonly receipt: MemoryForgetReceipt;
  };
  readonly phase4_read_memory_forget: { readonly sessionId: string; readonly toolRunId: string };
  readonly phase4_save_prepared_tool: PreparedToolCall;
  readonly phase4_read_tool_call: { readonly sessionId: string; readonly toolRunId: string };
  readonly phase4_ensure_memory_policy: {
    readonly scopeKey: string;
    readonly privacyRevision: string;
    readonly sessionId?: string | undefined;
  };
  readonly phase4_read_memory_policy: { readonly scopeKey: string };
  readonly phase4_change_memory_policy: MemoryPolicyChange;
  readonly phase4_read_provider_state: ProviderStateScope;
  readonly phase4_write_provider_state: ProviderStateWrite;
  readonly phase4_prepare_effects: EffectPreparation;
  readonly phase4_bind_audio_segment: AudioSegmentBinding;
  readonly phase4_confirm_effect: ConfirmEffectInput;
  readonly phase4_close_effects: { readonly sessionId: string; readonly sceneId: string };
  readonly phase4_read_confirmed_speech: {
    readonly sessionId: string;
    readonly limit: number;
    readonly policy?: MemoryPolicyStamp | undefined;
  };
  readonly phase4_read_context_manifest: { readonly sessionId: string; readonly cycleId: string };
  readonly read_disk_status: void;
  readonly ping: void;
  readonly migrate: void;
  readonly ensure_session: {
    readonly sessionId: string;
    readonly createdAtMs: number;
  };
  readonly append_record: { readonly record: unknown };
  readonly commit_scene: {
    readonly sceneId: string;
    readonly cycleId: string;
    readonly sessionId: string;
    readonly scene: Scene;
    /** Phase 2：可选完整 ScenePlan（写入 scenes.plan_json）。 */
    readonly plan?: ScenePlan;
    readonly idempotencyKey: string;
    readonly requestFingerprint: string;
    readonly watermarks: ReadonlyArray<{ source: string; watermark: bigint }>;
    readonly outbox: readonly OutboxMessage[];
  };
  readonly advance_server_seq: {
    readonly sessionId: string;
    readonly latestServerSeq: bigint;
  };
  readonly read_recovery_state: { readonly sessionId: string };
  readonly list_records: {
    readonly sessionId?: string | undefined;
    readonly traceId?: string | undefined;
    readonly aggregateId?: string | undefined;
    readonly recordType?: string | undefined;
    readonly order?: "asc" | "desc" | undefined;
    readonly limit?: number | undefined;
  };
  readonly list_active_scenes: { readonly sessionId: string };
  readonly claim_outbox: {
    readonly limit: number;
    readonly leaseMs: number;
    readonly ownerInstanceId: string;
  };
  readonly complete_outbox: CompleteOutboxInput;
  readonly retry_outbox: {
    readonly outboxId: string;
    readonly ownerInstanceId: string;
    readonly errorCode: string;
    readonly retryable: boolean;
  };
  readonly read_outbox_stats: void;
  readonly phase3_append_signal: {
    readonly policy?: MemoryPolicyStamp;
    readonly observations?: readonly MemoryInputObservation[];
    readonly sessionId: string;
    readonly signal: Signal;
    readonly priorityClass: "normal" | "urgent";
    readonly receivedAtMs: number;
    readonly normalCapacity: number;
    readonly urgentCapacity: number;
  };
  readonly phase3_restore_signals: { readonly sessionId: string };
  readonly phase3_adopt_cycle: {
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
  };
  readonly phase3_tool_run_event: {
    readonly sessionId: string;
    readonly toolRunId: string;
    readonly cycleId: string;
    readonly toolName: string;
    readonly transition: "started" | "finished";
    readonly state: string;
    readonly durationMs: number | null;
    readonly errorCode: string | null;
    readonly cacheSource: string | null;
    readonly resultSummary: unknown;
  };
  readonly phase3_read_decision_state: {
    readonly sessionId: string;
    readonly markUncertain: boolean;
  };
  readonly phase3_tool_cache_get: { readonly cacheKey: string };
  readonly phase3_tool_cache_set: {
    readonly cacheKey: string;
    readonly toolName: string;
    readonly payload: unknown;
    readonly ttlMs: number;
  };
}

export interface OperationResults {
  readonly phase4_record_recall_request: void;
  readonly phase4_read_history_recovery_state: HistoryRecoveryState;
  readonly phase4_read_revalidation_request: MemoryRecallRequest | null;
  readonly phase4_record_history_verification: void;
  readonly phase4_read_history_verification_page: HistoryVerificationPage;
  readonly phase4_begin_history_inventory: HistoryInventory;
  readonly phase4_read_history_inventory_page: HistoryInventoryPage;
  readonly phase4_read_history_inventory_item: HistoryInventoryItem;
  readonly phase4_begin_history_gap: MemoryPolicySnapshot;
  readonly phase4_apply_resource_invalidation: MemoryPolicySnapshot;
  readonly phase4_read_local_visibility: LocalInputVisibility;
  readonly phase4_read_prepared_tool: PreparedToolCall | null;
  readonly phase4_begin_memory_forget: MemoryForgetTransition;
  readonly phase4_complete_memory_forget: MemoryForgetTransition;
  readonly phase4_read_memory_forget: MemoryForgetOperation | null;
  readonly phase4_save_prepared_tool: void;
  readonly phase4_read_tool_call: import("@bellis/contracts").ToolCall | null;
  readonly phase4_ensure_memory_policy: MemoryPolicySnapshot;
  readonly phase4_read_memory_policy: MemoryPolicySnapshot;
  readonly phase4_change_memory_policy: MemoryPolicySnapshot;
  readonly phase4_read_provider_state: ProviderStateSnapshot | null;
  readonly phase4_write_provider_state: number;
  readonly phase4_prepare_effects: void;
  readonly phase4_bind_audio_segment: void;
  readonly phase4_confirm_effect: StageEffectAck;
  readonly phase4_close_effects: void;
  readonly phase4_read_confirmed_speech: { readonly items: readonly ConfirmedSpeech[] };
  readonly phase4_read_context_manifest: {
    readonly manifest: ContextManifest;
    readonly manifestDigest: string;
  } | null;
  readonly read_disk_status: PersistenceDiskStatus;
  readonly ping: { readonly pongMs: number };
  readonly migrate: { readonly requeuedInFlight: number };
  readonly ensure_session: void;
  readonly append_record: { readonly record: unknown };
  readonly commit_scene: CommitSceneResult;
  readonly advance_server_seq: { readonly latestServerSeq: bigint };
  readonly read_recovery_state: RecoveryState;
  readonly list_records: { readonly records: readonly unknown[] };
  readonly list_active_scenes: { readonly scenes: readonly unknown[] };
  readonly claim_outbox: { readonly messages: readonly unknown[] };
  readonly complete_outbox: void;
  readonly retry_outbox: { readonly disposition: "retry" | "dead" };
  readonly read_outbox_stats: OutboxStats;
  readonly phase3_append_signal:
    | { readonly result: "accepted" | "deduplicated"; readonly sequence: bigint }
    | { readonly result: "rejected"; readonly reason: "normal_capacity" | "urgent_capacity" };
  readonly phase3_restore_signals: {
    readonly pending: readonly IngestedSignal[];
    readonly lastAssigned: bigint;
    readonly consumed: bigint;
  };
  readonly phase3_adopt_cycle: void;
  readonly phase3_tool_run_event: void;
  readonly phase3_read_decision_state: {
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
  };
  readonly phase3_tool_cache_get: { readonly payload: unknown } | { readonly payload: null };
  readonly phase3_tool_cache_set: void;
}

export type OperationRequest<K extends PersistenceOperation = PersistenceOperation> = {
  [O in PersistenceOperation]: { readonly operation: O; readonly input: OperationInputs[O] };
}[K];

export type OperationResultMessage<K extends PersistenceOperation = PersistenceOperation> = {
  [O in PersistenceOperation]: { readonly operation: O; readonly result: OperationResults[O] };
}[K];

const CommitScenePayloadSchema = z.object({
  sceneId: UuidSchema,
  cycleId: UuidSchema,
  sessionId: UuidSchema,
  scene: SceneSchema,
  /** Phase 2 兼容新增：完整编译计划（scene-execution.md §9）。 */
  plan: ScenePlanSchema.optional(),
  idempotencyKey: FingerprintSchema,
  requestFingerprint: FingerprintSchema,
  watermarks: z.array(WatermarkEntryJsonSchema),
  outbox: z.array(OutboxMessageSchema),
});

const RecoveryStateResultSchema = z.object({
  sessionId: UuidSchema,
  latestServerSeq: DecimalStringSchema,
  signalWatermarks: z.array(WatermarkEntryJsonSchema),
  lastCommittedScene: z
    .object({
      sceneId: UuidSchema,
      cycleId: UuidSchema,
      committedAtMs: z.number().int().nonnegative(),
    })
    .nullable(),
});

const EnsureSessionPayloadSchema = z.object({
  sessionId: UuidSchema,
  createdAtMs: z.number().int().nonnegative(),
});

const AppendRecordPayloadSchema = z.object({ record: SessionRecordSchema });

const AdvanceServerSeqPayloadSchema = z.object({
  sessionId: UuidSchema,
  latestServerSeq: DecimalStringSchema,
});

const AdvanceServerSeqResultSchema = z.object({
  latestServerSeq: DecimalStringSchema,
});

const ListRecordsPayloadSchema = z.object({
  sessionId: UuidSchema.optional(),
  traceId: TraceIdSchema.optional(),
  aggregateId: z.string().min(1).max(128).optional(),
  recordType: z.string().min(1).max(64).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});

const ClaimOutboxPayloadSchema = z.object({
  limit: z.number().int().min(1).max(256),
  leaseMs: z.number().int().min(1).max(600_000),
  ownerInstanceId: z.string().min(1).max(128),
});

const OutboxIdPayloadSchema = z.object({
  outboxId: UuidSchema,
  ownerInstanceId: z.string().min(1).max(128),
});

const RetryOutboxPayloadSchema = OutboxIdPayloadSchema.extend({
  errorCode: z.string().min(1).max(64),
  retryable: z.boolean(),
});

const PingResultSchema = z.object({ pongMs: z.number().int().nonnegative() });
const MigrateResultSchema = z.object({
  requeuedInFlight: z.number().int().nonnegative(),
});
const RetryDispositionResultSchema = z.object({
  disposition: z.enum(["retry", "dead"]),
});
const CommitSceneResultSchema = z.object({
  sceneId: UuidSchema,
  committedAtMs: z.number().int().nonnegative(),
  duplicate: z.boolean(),
});
const OutboxStatsResultSchema = z.object({
  pending: z.number().int().nonnegative(),
  inFlight: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  dead: z.number().int().nonnegative(),
});
const ListRecordsResultSchema = z.object({ records: z.array(SessionRecordSchema) });

const Phase3AppendSignalPayloadSchema = z.object({
  policy: MemoryPolicyStampSchema.optional(),
  observations: z.array(MemoryInputObservationSchema).max(8).optional(),
  sessionId: UuidSchema,
  signal: SignalSchema,
  priorityClass: SignalPriorityClassSchema,
  receivedAtMs: z.number().int().nonnegative(),
  normalCapacity: z.number().int().min(1).max(100_000),
  urgentCapacity: z.number().int().min(1).max(100_000),
});

const Phase3AppendSignalResultSchema = z.union([
  z.object({
    result: z.enum(["accepted", "deduplicated"]),
    sequence: DecimalStringSchema,
  }),
  z.object({
    result: z.literal("rejected"),
    reason: z.enum(["normal_capacity", "urgent_capacity"]),
  }),
]);

const Phase3RestoreSignalsResultSchema = z.object({
  pending: z.array(IngestedSignalSchema),
  lastAssigned: DecimalStringSchema,
  consumed: DecimalStringSchema,
});

/** adoption 传输形态（审计记录 payload 由 Worker 侧组装并经 Schema 校验）。 */
const Phase3AdoptCyclePayloadSchema = z.object({
  context: ContextAdoptionSchema.optional(),
  sessionId: UuidSchema,
  turnId: UuidSchema,
  cycleId: UuidSchema,
  cycleIndex: z.number().int().nonnegative(),
  batchId: UuidSchema,
  watermarkFrom: DecimalStringSchema,
  watermarkTo: DecimalStringSchema,
  next: z.enum(["finish", "after_tools", "continue"]),
  degraded: z.boolean(),
  packetDigest: z.string().length(64),
  toolRuns: z.array(
    z.object({
      toolRunId: UuidSchema,
      toolName: z.string().min(1).max(128),
      idempotencyKeyHash: z.string().length(64).nullable(),
      originalCall: ToolCallSchema.optional(),
    }),
  ),
});

const Phase3ToolRunEventPayloadSchema = z.object({
  sessionId: UuidSchema,
  toolRunId: UuidSchema,
  cycleId: UuidSchema,
  toolName: z.string().min(1).max(128),
  transition: z.enum(["started", "finished"]),
  state: ToolRunStateSchema,
  durationMs: z.number().int().nonnegative().nullable(),
  errorCode: z.string().min(1).max(64).nullable(),
  cacheSource: z.enum(["l0", "l1", "l2"]).nullable(),
  resultSummary: z.unknown(),
});

const Phase3DecisionStateResultSchema = z.object({
  consumed: DecimalStringSchema,
  cycles: z.array(
    z.object({
      cycleId: UuidSchema,
      turnId: UuidSchema,
      cycleIndex: z.number().int().nonnegative(),
      watermarkTo: DecimalStringSchema,
      degraded: z.boolean(),
      next: z.string().min(1).max(16),
    }),
  ),
  toolRuns: z.array(
    z.object({
      toolRunId: UuidSchema,
      cycleId: UuidSchema,
      toolName: z.string().min(1).max(128),
      state: z.string().min(1).max(32),
      idempotencyKeyHash: z.string().length(64).nullable(),
      cacheSource: z.enum(["l0", "l1", "l2"]).nullable(),
      errorCode: z.string().min(1).max(64).nullable(),
    }),
  ),
  uncertainMarked: z.number().int().nonnegative(),
});

const Phase3ToolCacheGetResultSchema = z.object({
  payload: z.union([z.null(), z.unknown()]),
});

const ActiveSceneRowSchema = z.object({
  sceneId: z.string().min(1).max(128),
  cycleId: z.string().min(1).max(128).nullable(),
  state: z.string().min(1).max(32),
  updatedAtMs: z.number().int().nonnegative(),
  durable: z.boolean(),
  durableCycleId: z.string().min(1).max(128).nullable(),
});

const ActiveScenesResultSchema = z.object({ scenes: z.array(ActiveSceneRowSchema) });
const ClaimOutboxResultSchema = z.object({ messages: z.array(OutboxMessageSchema) });
const ProviderStateScopeSchema = z.strictObject({
  scopeKey: z.string().regex(/^[a-f0-9]{64}$/),
  providerId: z.string().min(1).max(256),
});
const ProviderRevisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

function invalid(message: string): PersistenceError {
  return new PersistenceError("invalid_request", message);
}

function internal(message: string): PersistenceError {
  return new PersistenceError("internal", message);
}

function parseOr<S extends z.ZodType>(
  schema: S,
  value: unknown,
  error: PersistenceError,
): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw error;
  }
  return parsed.data;
}

/** Client→Worker Payload 编码（typed 输入 → JsonValue）。 */
export function encodeOperationPayload(message: OperationRequest): Record<string, unknown> {
  switch (message.operation) {
    case "phase4_ensure_memory_policy":
    case "phase4_read_memory_policy":
    case "phase4_change_memory_policy":
      return { ...message.input };
    case "phase4_begin_memory_forget":
    case "phase4_complete_memory_forget":
    case "phase4_read_memory_forget":
    case "phase4_record_recall_request":
    case "phase4_read_history_recovery_state":
    case "phase4_read_revalidation_request":
    case "phase4_record_history_verification":
    case "phase4_read_history_verification_page":
    case "phase4_begin_history_inventory":
    case "phase4_read_history_inventory_page":
    case "phase4_read_history_inventory_item":
    case "phase4_begin_history_gap":
    case "phase4_apply_resource_invalidation":
    case "phase4_read_local_visibility":
    case "phase4_read_prepared_tool":
    case "phase4_save_prepared_tool":
    case "phase4_read_tool_call":
      return { ...message.input };
    case "phase4_read_provider_state":
    case "phase4_write_provider_state":
      return { ...message.input };
    case "phase4_prepare_effects":
    case "phase4_bind_audio_segment":
    case "phase4_confirm_effect":
    case "phase4_close_effects":
    case "phase4_read_confirmed_speech":
      return { ...message.input };
    case "phase4_read_context_manifest":
      return { ...message.input };
    case "read_disk_status":
    case "ping":
    case "migrate":
    case "read_outbox_stats":
      return {};
    case "ensure_session":
      return {
        sessionId: message.input.sessionId,
        createdAtMs: message.input.createdAtMs,
      };
    case "append_record":
      return { record: message.input.record };
    case "commit_scene":
      return {
        sceneId: message.input.sceneId,
        cycleId: message.input.cycleId,
        sessionId: message.input.sessionId,
        scene: message.input.scene,
        ...(message.input.plan === undefined ? {} : { plan: message.input.plan }),
        idempotencyKey: message.input.idempotencyKey,
        requestFingerprint: message.input.requestFingerprint,
        watermarks: message.input.watermarks.map((entry) => ({
          source: entry.source,
          watermark: formatDecimalString(entry.watermark),
        })),
        outbox: message.input.outbox,
      };
    case "advance_server_seq":
      return {
        sessionId: message.input.sessionId,
        latestServerSeq: formatDecimalString(message.input.latestServerSeq),
      };
    case "read_recovery_state":
      return { sessionId: message.input.sessionId };
    case "list_records":
      return { ...message.input };
    case "list_active_scenes":
      return { ...message.input };
    case "claim_outbox":
      return { ...message.input };
    case "complete_outbox":
      return { ...message.input };
    case "retry_outbox":
      return { ...message.input };
    case "phase3_append_signal":
      return {
        ...(message.input.policy === undefined ? {} : { policy: message.input.policy }),
        ...(message.input.observations === undefined
          ? {}
          : { observations: message.input.observations }),
        sessionId: message.input.sessionId,
        signal: message.input.signal,
        priorityClass: message.input.priorityClass,
        receivedAtMs: message.input.receivedAtMs,
        normalCapacity: message.input.normalCapacity,
        urgentCapacity: message.input.urgentCapacity,
      };
    case "phase3_restore_signals":
      return { sessionId: message.input.sessionId };
    case "phase3_adopt_cycle":
      return {
        ...(message.input.context === undefined ? {} : { context: message.input.context }),
        sessionId: message.input.sessionId,
        turnId: message.input.turnId,
        cycleId: message.input.cycleId,
        cycleIndex: message.input.cycleIndex,
        batchId: message.input.batchId,
        watermarkFrom: formatDecimalString(message.input.watermarkFrom),
        watermarkTo: formatDecimalString(message.input.watermarkTo),
        next: message.input.next,
        degraded: message.input.degraded,
        packetDigest: message.input.packetDigest,
        toolRuns: message.input.toolRuns,
      };
    case "phase3_tool_run_event":
      return {
        sessionId: message.input.sessionId,
        toolRunId: message.input.toolRunId,
        cycleId: message.input.cycleId,
        toolName: message.input.toolName,
        transition: message.input.transition,
        state: message.input.state,
        durationMs: message.input.durationMs,
        errorCode: message.input.errorCode,
        cacheSource: message.input.cacheSource,
        resultSummary: message.input.resultSummary,
      };
    case "phase3_read_decision_state":
      return { ...message.input };
    case "phase3_tool_cache_get":
      return { cacheKey: message.input.cacheKey };
    case "phase3_tool_cache_set":
      return {
        cacheKey: message.input.cacheKey,
        toolName: message.input.toolName,
        payload: message.input.payload,
        ttlMs: message.input.ttlMs,
      };
  }
}

/** Worker 侧 Payload 解码（JsonValue → typed 输入；失败 = invalid_request）。 */
export function decodeOperationPayload(
  operation: PersistenceOperation,
  payload: unknown,
): OperationRequest {
  switch (operation) {
    case "phase4_ensure_memory_policy":
      return {
        operation,
        input: parseOr(
          z.strictObject({
            scopeKey: MemoryPolicyStampSchema.shape.scopeKey,
            privacyRevision: z.string().min(1).max(256),
            sessionId: UuidSchema.optional(),
          }),
          payload,
          invalid("invalid memory policy initialization"),
        ),
      };
    case "phase4_read_memory_policy":
      return {
        operation,
        input: parseOr(
          z.strictObject({ scopeKey: MemoryPolicyStampSchema.shape.scopeKey }),
          payload,
          invalid("invalid memory policy scope"),
        ),
      };
    case "phase4_change_memory_policy":
      return {
        operation,
        input: parseOr(MemoryPolicyChangeSchema, payload, invalid("invalid memory policy change")),
      };
    case "phase4_begin_memory_forget":
    case "phase4_read_memory_forget":
      return {
        operation,
        input: parseOr(
          z.strictObject({ sessionId: UuidSchema, toolRunId: UuidSchema }),
          payload,
          invalid("invalid memory forget identity"),
        ),
      };
    case "phase4_complete_memory_forget":
      return {
        operation,
        input: parseOr(
          z.strictObject({
            sessionId: UuidSchema,
            toolRunId: UuidSchema,
            receipt: MemoryForgetReceiptSchema,
          }),
          payload,
          invalid("invalid memory forget receipt"),
        ),
      };
    case "phase4_save_prepared_tool":
      return {
        operation,
        input: parseOr(PreparedToolCallSchema, payload, invalid("prepared tool invalid")),
      };
    case "phase4_record_recall_request":
      return {
        operation,
        input: parseOr(RecallRequestWriteSchema, payload, invalid("Recall request record invalid")),
      };
    case "phase4_read_history_recovery_state":
      return {
        operation,
        input: parseOr(
          HistoryRecoveryInputSchema,
          payload,
          invalid("history recovery input invalid"),
        ),
      };
    case "phase4_read_revalidation_request":
      return {
        operation,
        input: parseOr(
          HistoryInventoryItemInputSchema,
          payload,
          invalid("revalidation request input invalid"),
        ),
      };
    case "phase4_record_history_verification":
      return {
        operation,
        input: parseOr(
          HistoryVerificationBatchSchema,
          payload,
          invalid("history verification input invalid"),
        ),
      };
    case "phase4_read_history_verification_page":
      return {
        operation,
        input: parseOr(
          HistoryInventoryPageInputSchema,
          payload,
          invalid("history verification page input invalid"),
        ),
      };
    case "phase4_begin_history_inventory":
      return {
        operation,
        input: parseOr(
          HistoryInventoryBeginSchema,
          payload,
          invalid("history inventory input invalid"),
        ),
      };
    case "phase4_read_history_inventory_page":
      return {
        operation,
        input: parseOr(
          HistoryInventoryPageInputSchema,
          payload,
          invalid("history inventory input invalid"),
        ),
      };
    case "phase4_read_history_inventory_item":
      return {
        operation,
        input: parseOr(
          HistoryInventoryItemInputSchema,
          payload,
          invalid("history inventory input invalid"),
        ),
      };
    case "phase4_begin_history_gap":
      return {
        operation,
        input: parseOr(
          z.strictObject({
            scopeKey: MemoryPolicyStampSchema.shape.scopeKey,
            gap: MemoryHistoryGapSchema,
          }),
          payload,
          invalid("history gap input invalid"),
        ),
      };
    case "phase4_apply_resource_invalidation":
      return {
        operation,
        input: parseOr(
          z.strictObject({
            scopeKey: MemoryPolicyStampSchema.shape.scopeKey,
            event: MemoryResourceInvalidationSchema,
          }),
          payload,
          invalid("resource invalidation input invalid"),
        ),
      };
    case "phase4_read_local_visibility":
      return {
        operation,
        input: parseOr(
          LocalInputVisibilityRequestSchema,
          payload,
          invalid("local visibility input invalid"),
        ),
      };
    case "phase4_read_prepared_tool":
      return {
        operation,
        input: parseOr(
          z.strictObject({ sessionId: UuidSchema, toolRunId: UuidSchema }),
          payload,
          invalid("prepared tool scope invalid"),
        ),
      };
    case "phase4_read_tool_call":
      return {
        operation,
        input: parseOr(
          z.strictObject({ sessionId: UuidSchema, toolRunId: UuidSchema }),
          payload,
          invalid("tool call scope invalid"),
        ),
      };
    case "phase4_read_provider_state":
      return {
        operation,
        input: parseOr(ProviderStateScopeSchema, payload, invalid("provider state scope invalid")),
      };
    case "phase4_write_provider_state":
      return {
        operation,
        input: parseOr(
          ProviderStateScopeSchema.extend({
            expectedRevision: ProviderRevisionSchema,
            state: JsonValueSchema,
          }),
          payload,
          invalid("provider state write invalid"),
        ),
      };
    case "phase4_prepare_effects":
      return {
        operation,
        input: parseOr(
          EffectPreparationSchema,
          payload,
          invalid("phase4_prepare_effects payload invalid"),
        ),
      };
    case "phase4_bind_audio_segment":
      return {
        operation,
        input: parseOr(
          AudioSegmentBindingSchema,
          payload,
          invalid("phase4_bind_audio_segment payload invalid"),
        ),
      };
    case "phase4_confirm_effect":
      return {
        operation,
        input: parseOr(
          z.strictObject({
            sessionId: UuidSchema,
            connectionGeneration: UuidSchema,
            receipt: StageEffectReceiptSchema,
          }),
          payload,
          invalid("phase4_confirm_effect payload invalid"),
        ),
      };
    case "phase4_close_effects":
      return {
        operation,
        input: parseOr(
          z.strictObject({ sessionId: UuidSchema, sceneId: UuidSchema }),
          payload,
          invalid("phase4_close_effects payload invalid"),
        ),
      };
    case "phase4_read_confirmed_speech":
      return {
        operation,
        input: parseOr(
          z.strictObject({
            sessionId: UuidSchema,
            limit: z.number().int().min(1).max(64),
            policy: MemoryPolicyStampSchema.optional(),
          }),
          payload,
          invalid("phase4_read_confirmed_speech payload invalid"),
        ),
      };
    case "phase4_read_context_manifest":
      return {
        operation,
        input: parseOr(
          z.strictObject({ sessionId: UuidSchema, cycleId: UuidSchema }),
          payload,
          invalid("context manifest read payload failed validation"),
        ),
      };
    case "read_disk_status":
      parseOr(z.strictObject({}), payload, invalid("invalid disk status query"));
      return { operation, input: undefined };
    case "ping":
    case "migrate":
    case "read_outbox_stats":
      return { operation, input: undefined };
    case "ensure_session":
      return {
        operation,
        input: parseOr(
          EnsureSessionPayloadSchema,
          payload,
          invalid("ensure_session payload failed validation"),
        ),
      };
    case "append_record":
      return {
        operation,
        input: {
          record: parseOr(
            AppendRecordPayloadSchema,
            payload,
            invalid("append_record payload failed validation"),
          ).record,
        },
      };
    case "commit_scene": {
      const parsed = parseOr(
        CommitScenePayloadSchema,
        payload,
        invalid("commit_scene payload failed validation"),
      );
      return {
        operation,
        input: {
          sceneId: parsed.sceneId,
          cycleId: parsed.cycleId,
          sessionId: parsed.sessionId,
          scene: parsed.scene,
          ...(parsed.plan === undefined ? {} : { plan: parsed.plan }),
          idempotencyKey: parsed.idempotencyKey,
          requestFingerprint: parsed.requestFingerprint,
          watermarks: parsed.watermarks.map((entry) => ({
            source: entry.source,
            watermark: parseDecimalString(entry.watermark),
          })),
          outbox: parsed.outbox,
        },
      };
    }
    case "advance_server_seq": {
      const parsed = parseOr(
        AdvanceServerSeqPayloadSchema,
        payload,
        invalid("advance_server_seq payload failed validation"),
      );
      return {
        operation,
        input: {
          sessionId: parsed.sessionId,
          latestServerSeq: parseDecimalString(parsed.latestServerSeq),
        },
      };
    }
    case "read_recovery_state":
      return {
        operation,
        input: parseOr(
          z.object({ sessionId: UuidSchema }),
          payload,
          invalid("read_recovery_state payload failed validation"),
        ),
      };
    case "list_records":
      return {
        operation,
        input: parseOr(
          ListRecordsPayloadSchema,
          payload,
          invalid("list_records payload failed validation"),
        ),
      };
    case "list_active_scenes":
      return {
        operation,
        input: parseOr(
          z.object({ sessionId: UuidSchema }),
          payload,
          invalid("list_active_scenes payload failed validation"),
        ),
      };
    case "claim_outbox":
      return {
        operation,
        input: parseOr(
          ClaimOutboxPayloadSchema,
          payload,
          invalid("claim_outbox payload failed validation"),
        ),
      };
    case "complete_outbox":
      return {
        operation,
        input: parseOr(
          OutboxIdPayloadSchema,
          payload,
          invalid("complete_outbox payload failed validation"),
        ),
      };
    case "retry_outbox":
      return {
        operation,
        input: parseOr(
          RetryOutboxPayloadSchema,
          payload,
          invalid("retry_outbox payload failed validation"),
        ),
      };
    case "phase3_append_signal": {
      const parsed = parseOr(
        Phase3AppendSignalPayloadSchema,
        payload,
        invalid("phase3_append_signal payload failed validation"),
      );
      return {
        operation,
        input: {
          ...(parsed.policy === undefined ? {} : { policy: parsed.policy }),
          ...(parsed.observations === undefined ? {} : { observations: parsed.observations }),
          sessionId: parsed.sessionId,
          signal: parsed.signal,
          priorityClass: parsed.priorityClass,
          receivedAtMs: parsed.receivedAtMs,
          normalCapacity: parsed.normalCapacity,
          urgentCapacity: parsed.urgentCapacity,
        },
      };
    }
    case "phase3_restore_signals":
      return {
        operation,
        input: parseOr(
          z.object({ sessionId: UuidSchema }),
          payload,
          invalid("phase3_restore_signals payload failed validation"),
        ),
      };
    case "phase3_adopt_cycle": {
      const parsed = parseOr(
        Phase3AdoptCyclePayloadSchema,
        payload,
        invalid("phase3_adopt_cycle payload failed validation"),
      );
      return {
        operation,
        input: {
          ...(parsed.context === undefined ? {} : { context: parsed.context }),
          sessionId: parsed.sessionId,
          turnId: parsed.turnId,
          cycleId: parsed.cycleId,
          cycleIndex: parsed.cycleIndex,
          batchId: parsed.batchId,
          watermarkFrom: parseDecimalString(parsed.watermarkFrom),
          watermarkTo: parseDecimalString(parsed.watermarkTo),
          next: parsed.next,
          degraded: parsed.degraded,
          packetDigest: parsed.packetDigest,
          toolRuns: parsed.toolRuns,
        },
      };
    }
    case "phase3_tool_run_event": {
      const parsed = parseOr(
        Phase3ToolRunEventPayloadSchema,
        payload,
        invalid("phase3_tool_run_event payload failed validation"),
      );
      return {
        operation,
        input: {
          sessionId: parsed.sessionId,
          toolRunId: parsed.toolRunId,
          cycleId: parsed.cycleId,
          toolName: parsed.toolName,
          transition: parsed.transition,
          state: parsed.state,
          durationMs: parsed.durationMs,
          errorCode: parsed.errorCode,
          cacheSource: parsed.cacheSource,
          resultSummary: parsed.resultSummary,
        },
      };
    }
    case "phase3_read_decision_state":
      return {
        operation,
        input: parseOr(
          z.object({ sessionId: UuidSchema, markUncertain: z.boolean() }),
          payload,
          invalid("phase3_read_decision_state payload failed validation"),
        ),
      };
    case "phase3_tool_cache_get":
      return {
        operation,
        input: parseOr(
          z.object({ cacheKey: z.string().min(16).max(128) }),
          payload,
          invalid("phase3_tool_cache_get payload failed validation"),
        ),
      };
    case "phase3_tool_cache_set":
      return {
        operation,
        input: parseOr(
          z.object({
            cacheKey: z.string().min(16).max(128),
            toolName: z.string().min(1).max(128),
            payload: z.unknown(),
            ttlMs: z.number().int().min(1).max(86_400_000),
          }),
          payload,
          invalid("phase3_tool_cache_set payload failed validation"),
        ),
      };
  }
}

/** Worker→Client Result 编码（typed 结果 → JsonValue）。 */
export function encodeOperationResult(message: OperationResultMessage): Record<string, unknown> {
  switch (message.operation) {
    case "phase4_ensure_memory_policy":
    case "phase4_read_memory_policy":
    case "phase4_change_memory_policy":
      return { ...message.result };
    case "phase4_read_history_recovery_state":
      return { ...message.result };
    case "phase4_read_revalidation_request":
      return { request: message.result };
    case "phase4_record_history_verification":
    case "phase4_record_recall_request":
    case "phase4_save_prepared_tool":
      return {};
    case "phase4_begin_memory_forget":
    case "phase4_complete_memory_forget":
      return { ...message.result };
    case "phase4_read_memory_forget":
      return { operation: message.result };
    case "phase4_read_history_verification_page":
    case "phase4_begin_history_inventory":
    case "phase4_read_history_inventory_page":
    case "phase4_read_history_inventory_item":
    case "phase4_begin_history_gap":
    case "phase4_apply_resource_invalidation":
    case "phase4_read_local_visibility":
      return { ...message.result };
    case "phase4_read_prepared_tool":
      return { prepared: message.result };
    case "phase4_read_tool_call":
      return { call: message.result };
    case "phase4_read_provider_state":
      return { snapshot: message.result };
    case "phase4_write_provider_state":
      return { revision: message.result };
    case "phase4_prepare_effects":
    case "phase4_bind_audio_segment":
    case "phase4_close_effects":
      return {};
    case "phase4_confirm_effect":
      return { ...message.result };
    case "phase4_read_confirmed_speech":
      return { items: message.result.items };
    case "phase4_read_context_manifest":
      return { context: message.result };
    case "read_disk_status":
      return { ...message.result };
    case "ping":
      return { pongMs: message.result.pongMs };
    case "migrate":
      return { requeuedInFlight: message.result.requeuedInFlight };
    case "ensure_session":
    case "complete_outbox":
      return {};
    case "retry_outbox":
      return { disposition: message.result.disposition };
    case "append_record":
      return { record: message.result.record };
    case "commit_scene":
      return { ...message.result };
    case "advance_server_seq":
      return {
        latestServerSeq: formatDecimalString(message.result.latestServerSeq),
      };
    case "read_recovery_state":
      return {
        sessionId: message.result.sessionId,
        latestServerSeq: formatDecimalString(message.result.latestServerSeq),
        signalWatermarks: message.result.signalWatermarks.map((entry) => ({
          source: entry.source,
          watermark: formatDecimalString(entry.watermark),
        })),
        lastCommittedScene: message.result.lastCommittedScene,
      };
    case "list_records":
      return { records: message.result.records };
    case "list_active_scenes":
      return { scenes: message.result.scenes };
    case "claim_outbox":
      return { messages: message.result.messages };
    case "read_outbox_stats":
      return { ...message.result };
    case "phase3_append_signal":
      if (message.result.result === "rejected") {
        return { result: "rejected", reason: message.result.reason };
      }
      return {
        result: message.result.result,
        sequence: formatDecimalString(message.result.sequence),
      };
    case "phase3_restore_signals":
      return {
        pending: message.result.pending,
        lastAssigned: formatDecimalString(message.result.lastAssigned),
        consumed: formatDecimalString(message.result.consumed),
      };
    case "phase3_adopt_cycle":
    case "phase3_tool_run_event":
    case "phase3_tool_cache_set":
      return {};
    case "phase3_read_decision_state":
      return {
        consumed: formatDecimalString(message.result.consumed),
        cycles: message.result.cycles.map((cycle) => ({
          ...cycle,
          watermarkTo: formatDecimalString(cycle.watermarkTo),
        })),
        toolRuns: message.result.toolRuns,
        uncertainMarked: message.result.uncertainMarked,
      };
    case "phase3_tool_cache_get":
      return { payload: message.result.payload };
  }
}

/** Client 侧 Result 解码（JsonValue → typed 结果；失败 = internal）。 */
export function decodeOperationResult(
  operation: PersistenceOperation,
  payload: unknown,
): OperationResultMessage {
  switch (operation) {
    case "phase4_ensure_memory_policy":
    case "phase4_read_memory_policy":
    case "phase4_change_memory_policy":
      return {
        operation,
        result: parseOr(
          MemoryPolicySnapshotSchema,
          payload,
          internal("invalid memory policy result"),
        ),
      };
    case "phase4_begin_memory_forget":
    case "phase4_complete_memory_forget":
      return {
        operation,
        result: parseOr(
          z.strictObject({
            operation: MemoryForgetOperationSchema,
            policy: MemoryPolicySnapshotSchema,
          }),
          payload,
          internal("invalid memory forget transition"),
        ),
      };
    case "phase4_read_memory_forget":
      return {
        operation,
        result: parseOr(
          z.strictObject({ operation: MemoryForgetOperationSchema.nullable() }),
          payload,
          internal("invalid memory forget result"),
        ).operation,
      };
    case "phase4_read_history_recovery_state":
      return {
        operation,
        result: parseOr(
          HistoryRecoveryStateSchema,
          payload,
          internal("history recovery state invalid"),
        ),
      };
    case "phase4_read_revalidation_request":
      return {
        operation,
        result: parseOr(
          z.strictObject({ request: MemoryRecallRequestSchema.nullable() }),
          payload,
          internal("revalidation request result invalid"),
        ).request,
      };
    case "phase4_record_history_verification":
    case "phase4_record_recall_request":
    case "phase4_save_prepared_tool":
      return { operation, result: undefined };
    case "phase4_read_history_verification_page":
      return {
        operation,
        result: parseOr(
          HistoryVerificationPageSchema,
          payload,
          internal("history verification page invalid"),
        ),
      };
    case "phase4_begin_history_inventory":
      return {
        operation,
        result: parseOr(
          HistoryInventorySchema,
          payload,
          internal("history inventory result invalid"),
        ),
      };
    case "phase4_read_history_inventory_page":
      return {
        operation,
        result: parseOr(
          HistoryInventoryPageSchema,
          payload,
          internal("history inventory result invalid"),
        ),
      };
    case "phase4_read_history_inventory_item":
      return {
        operation,
        result: parseOr(
          HistoryInventoryItemSchema,
          payload,
          internal("history inventory result invalid"),
        ),
      };
    case "phase4_begin_history_gap":
    case "phase4_apply_resource_invalidation":
      return {
        operation,
        result: parseOr(
          MemoryPolicySnapshotSchema,
          payload,
          internal("resource invalidation result invalid"),
        ),
      };
    case "phase4_read_local_visibility":
      return {
        operation,
        result: parseOr(
          LocalInputVisibilitySchema,
          payload,
          internal("local visibility result invalid"),
        ),
      };
    case "phase4_read_prepared_tool":
      return {
        operation,
        result: parseOr(
          z.strictObject({ prepared: PreparedToolCallSchema.nullable() }),
          payload,
          internal("prepared tool result invalid"),
        ).prepared,
      };
    case "phase4_read_tool_call":
      return {
        operation,
        result: parseOr(
          z.strictObject({ call: ToolCallSchema.nullable() }),
          payload,
          internal("tool call result invalid"),
        ).call,
      };
    case "phase4_read_provider_state":
      return {
        operation,
        result: parseOr(
          z.strictObject({
            snapshot: z
              .strictObject({ revision: ProviderRevisionSchema, state: JsonValueSchema })
              .nullable(),
          }),
          payload,
          internal("provider state snapshot invalid"),
        ).snapshot,
      };
    case "phase4_write_provider_state":
      return {
        operation,
        result: parseOr(
          z.strictObject({ revision: ProviderRevisionSchema }),
          payload,
          internal("provider state revision invalid"),
        ).revision,
      };
    case "phase4_prepare_effects":
    case "phase4_bind_audio_segment":
    case "phase4_close_effects":
      parseOr(z.strictObject({}), payload, internal("effect write result invalid"));
      return { operation, result: undefined };
    case "phase4_confirm_effect":
      return {
        operation,
        result: parseOr(StageEffectAckSchema, payload, internal("effect acknowledgment invalid")),
      };
    case "phase4_read_confirmed_speech":
      return {
        operation,
        result: parseOr(
          z.strictObject({
            items: z
              .array(
                z.strictObject({
                  cycleId: UuidSchema,
                  receiptId: UuidSchema,
                  text: z.string().min(1).max(2000),
                  start: z.number().int().min(0).max(2000),
                  end: z.number().int().min(1).max(2000),
                  confirmedAtMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
                }),
              )
              .max(64),
          }),
          payload,
          internal("confirmed speech result invalid"),
        ),
      };
    case "phase4_read_context_manifest":
      return {
        operation,
        result: parseOr(
          z.strictObject({
            context: z
              .strictObject({
                manifest: ContextManifestSchema,
                manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
              })
              .nullable(),
          }),
          payload,
          internal("context manifest read result failed validation"),
        ).context,
      };
    case "read_disk_status":
      return {
        operation,
        result: parseOr(
          PersistenceDiskStatusSchema,
          payload,
          internal("invalid disk status result"),
        ),
      };
    case "ping":
      return {
        operation,
        result: parseOr(PingResultSchema, payload, internal("ping result failed validation")),
      };
    case "migrate":
      return {
        operation,
        result: parseOr(MigrateResultSchema, payload, internal("migrate result failed validation")),
      };
    case "ensure_session":
    case "complete_outbox":
      return { operation, result: undefined };
    case "retry_outbox":
      return {
        operation,
        result: parseOr(
          RetryDispositionResultSchema,
          payload,
          internal("retry_outbox result failed validation"),
        ),
      };
    case "append_record":
      return {
        operation,
        result: {
          record: parseOr(
            AppendRecordPayloadSchema,
            payload,
            internal("append_record result failed validation"),
          ).record,
        },
      };
    case "commit_scene":
      return {
        operation,
        result: parseOr(
          CommitSceneResultSchema,
          payload,
          internal("commit_scene result failed validation"),
        ),
      };
    case "advance_server_seq": {
      const parsed = parseOr(
        AdvanceServerSeqResultSchema,
        payload,
        internal("advance_server_seq result failed validation"),
      );
      return {
        operation,
        result: { latestServerSeq: parseDecimalString(parsed.latestServerSeq) },
      };
    }
    case "read_recovery_state": {
      const parsed = parseOr(
        RecoveryStateResultSchema,
        payload,
        internal("read_recovery_state result failed validation"),
      );
      return {
        operation,
        result: {
          sessionId: parsed.sessionId,
          latestServerSeq: parseDecimalString(parsed.latestServerSeq),
          signalWatermarks: parsed.signalWatermarks.map((entry) => ({
            source: entry.source,
            watermark: parseDecimalString(entry.watermark),
          })),
          lastCommittedScene: parsed.lastCommittedScene,
        },
      };
    }
    case "list_records":
      return {
        operation,
        result: {
          records: parseOr(
            ListRecordsResultSchema,
            payload,
            internal("list_records result failed validation"),
          ).records,
        },
      };
    case "list_active_scenes":
      return {
        operation,
        result: {
          scenes: parseOr(
            ActiveScenesResultSchema,
            payload,
            internal("list_active_scenes result failed validation"),
          ).scenes,
        },
      };
    case "claim_outbox":
      return {
        operation,
        result: {
          messages: parseOr(
            ClaimOutboxResultSchema,
            payload,
            internal("claim_outbox result failed validation"),
          ).messages,
        },
      };
    case "read_outbox_stats":
      return {
        operation,
        result: parseOr(
          OutboxStatsResultSchema,
          payload,
          internal("read_outbox_stats result failed validation"),
        ),
      };
    case "phase3_append_signal": {
      const parsed = parseOr(
        Phase3AppendSignalResultSchema,
        payload,
        internal("phase3_append_signal result failed validation"),
      );
      if (parsed.result === "rejected") {
        return { operation, result: { result: "rejected", reason: parsed.reason } };
      }
      return {
        operation,
        result: { result: parsed.result, sequence: parseDecimalString(parsed.sequence) },
      };
    }
    case "phase3_restore_signals": {
      const parsed = parseOr(
        Phase3RestoreSignalsResultSchema,
        payload,
        internal("phase3_restore_signals result failed validation"),
      );
      return {
        operation,
        result: {
          pending: parsed.pending,
          lastAssigned: parseDecimalString(parsed.lastAssigned),
          consumed: parseDecimalString(parsed.consumed),
        },
      };
    }
    case "phase3_adopt_cycle":
    case "phase3_tool_run_event":
    case "phase3_tool_cache_set":
      return { operation, result: undefined };
    case "phase3_read_decision_state": {
      const parsed = parseOr(
        Phase3DecisionStateResultSchema,
        payload,
        internal("phase3_read_decision_state result failed validation"),
      );
      return {
        operation,
        result: {
          consumed: parseDecimalString(parsed.consumed),
          cycles: parsed.cycles.map((cycle) => ({
            ...cycle,
            watermarkTo: parseDecimalString(cycle.watermarkTo),
          })),
          toolRuns: parsed.toolRuns,
          uncertainMarked: parsed.uncertainMarked,
        },
      };
    }
    case "phase3_tool_cache_get": {
      const parsed = parseOr(
        Phase3ToolCacheGetResultSchema,
        payload,
        internal("phase3_tool_cache_get result failed validation"),
      );
      return { operation, result: { payload: parsed.payload } };
    }
  }
}
