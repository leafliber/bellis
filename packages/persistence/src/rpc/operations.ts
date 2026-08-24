import {
  DecimalStringSchema,
  OutboxMessageSchema,
  SceneSchema,
  SessionRecordSchema,
  TraceIdSchema,
  UuidSchema,
  formatDecimalString,
  parseDecimalString,
} from "@bellis/contracts";
import type { OutboxMessage, Scene } from "@bellis/contracts";
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
  "claim_outbox",
  "complete_outbox",
  "retry_outbox",
  "read_outbox_stats",
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
    readonly limit?: number | undefined;
  };
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
  readonly claim_outbox: { readonly messages: readonly unknown[] };
  readonly complete_outbox: void;
  readonly retry_outbox: { readonly disposition: "retry" | "dead" };
  readonly read_outbox_stats: OutboxStats;
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
    case "claim_outbox":
      return { ...message.input };
    case "complete_outbox":
      return { ...message.input };
    case "retry_outbox":
      return { ...message.input };
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
    case "claim_outbox":
      return { messages: message.result.messages };
    case "read_outbox_stats":
      return { ...message.result };
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
  }
}
