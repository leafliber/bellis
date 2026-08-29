import {
  DecimalStringSchema,
  IngestedSignalSchema,
  OutboxMessageSchema,
  ScenePlanSchema,
  SceneSchema,
  SessionRecordSchema,
  SignalSchema,
  SignalPriorityClassSchema,
  ToolRunStateSchema,
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
    readonly sessionId: string;
    readonly signal: Signal;
    readonly priorityClass: "normal" | "urgent";
    readonly receivedAtMs: number;
    readonly normalCapacity: number;
    readonly urgentCapacity: number;
  };
  readonly phase3_restore_signals: { readonly sessionId: string };
  readonly phase3_adopt_cycle: {
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
