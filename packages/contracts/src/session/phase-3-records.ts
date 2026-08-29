import { z } from "zod";
import { DecimalStringSchema } from "../common/decimal-string.js";
import { UuidSchema } from "../common/ids.js";
import { extensibleJsonObject } from "../common/json-value.js";
import { SignalPriorityClassSchema } from "../signal/ingested-signal.js";
import { ToolRunStateSchema } from "../decision/tool-run.js";

/**
 * Phase 3 审计 Record 的版本化 Payload（SessionRecordSchema 的闭合约定：
 * payload 写入前必须通过对应 recordType 的版本化 Schema）。
 *
 * - 只记录审计事实的最小充分集：不携带发言全文、模型原始 body、
 *   Provider API Key 或 Tool 原始大结果；
 * - idempotencyKey 只记录摘要（SHA-256 hex），不记录键本身；
 * - 未知 payloadVersion 的读取端必须 fail closed（§9.3）。
 */
export const PHASE_3_AUDIT_PAYLOAD_VERSION = 1;

const payloadVersion = z.literal(PHASE_3_AUDIT_PAYLOAD_VERSION);

/** recordType=phase3_signal_ingested。 */
export const Phase3SignalIngestedPayloadSchema = extensibleJsonObject({
  payloadVersion,
  signalId: UuidSchema,
  /** accepted/deduplicated 回显分配（或原）序号；rejected 无序号。 */
  sequence: DecimalStringSchema.optional(),
  result: z.enum(["accepted", "deduplicated", "rejected"]),
  priorityClass: SignalPriorityClassSchema.optional(),
  reason: z.string().min(1).max(64).optional(),
});

/** recordType=phase3_batch_sealed。 */
export const Phase3BatchSealedPayloadSchema = extensibleJsonObject({
  payloadVersion,
  batchId: UuidSchema,
  watermarkFrom: DecimalStringSchema,
  watermarkTo: DecimalStringSchema,
  trigger: z.enum(["deadline", "count", "token_budget", "byte_budget", "urgent_bypass", "close"]),
  messageCount: z.number().int().nonnegative(),
  urgentCount: z.number().int().nonnegative(),
  tokenEstimate: z.number().int().nonnegative(),
});

/** recordType=phase3_turn_started。 */
export const Phase3TurnStartedPayloadSchema = extensibleJsonObject({
  payloadVersion,
  turnId: UuidSchema,
  trigger: z.enum(["normal_batch", "interrupt", "next_turn"]),
  batchId: UuidSchema,
});

/** recordType=phase3_turn_finished。 */
export const Phase3TurnFinishedPayloadSchema = extensibleJsonObject({
  payloadVersion,
  turnId: UuidSchema,
  result: z.enum(["completed", "cancelled", "failed", "degraded"]),
  cycleCount: z.number().int().nonnegative(),
  reason: z.string().min(1).max(64).optional(),
});

/**
 * recordType=phase3_cycle_adopted。
 * Cycle adoption 的原子审计事实（ADR 0004）：本 Record 与水位推进、
 * Tool Run planned 行同事务写入。
 */
export const Phase3CycleAdoptedPayloadSchema = extensibleJsonObject({
  payloadVersion,
  turnId: UuidSchema,
  cycleId: UuidSchema,
  cycleIndex: z.number().int().nonnegative(),
  batchId: UuidSchema,
  watermarkFrom: DecimalStringSchema,
  watermarkTo: DecimalStringSchema,
  next: z.enum(["finish", "after_tools", "continue"]),
  degraded: z.boolean(),
  toolRunIds: z.array(UuidSchema).max(8),
  /** 采用包的 SHA-256 hex 摘要（64 字符）。 */
  packetDigest: z.string().length(64),
});

/** recordType=phase3_cycle_finished。 */
export const Phase3CycleFinishedPayloadSchema = extensibleJsonObject({
  payloadVersion,
  turnId: UuidSchema,
  cycleId: UuidSchema,
  result: z.enum(["completed", "cancelled", "failed"]),
  next: z.enum(["finish", "after_tools", "continue"]),
  sceneSubmitted: z.boolean(),
});

/**
 * recordType=phase3_model_request。
 * 模型请求的脱敏遥测事实：不记录 API Key、Prompt 全文或原始 body。
 */
export const Phase3ModelRequestPayloadSchema = extensibleJsonObject({
  payloadVersion,
  cycleId: UuidSchema,
  provider: z.string().min(1).max(64),
  outcome: z.enum(["final", "degraded", "failed", "aborted"]),
  ttftMs: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  degradationReason: z
    .enum(["timeout", "stream_broken", "invalid_packet", "content_policy", "aborted"])
    .optional(),
});

/** recordType=phase3_tool_run。 */
export const Phase3ToolRunPayloadSchema = extensibleJsonObject({
  payloadVersion,
  toolRunId: UuidSchema,
  cycleId: UuidSchema,
  toolName: z.string().min(1).max(128),
  transition: z.enum(["planned", "started", "finished"]),
  state: ToolRunStateSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  errorCode: z.string().min(1).max(64).optional(),
  idempotencyKeyHash: z.string().length(64).optional(),
});

export type Phase3SignalIngestedPayload = z.infer<typeof Phase3SignalIngestedPayloadSchema>;
export type Phase3BatchSealedPayload = z.infer<typeof Phase3BatchSealedPayloadSchema>;
export type Phase3TurnStartedPayload = z.infer<typeof Phase3TurnStartedPayloadSchema>;
export type Phase3TurnFinishedPayload = z.infer<typeof Phase3TurnFinishedPayloadSchema>;
export type Phase3CycleAdoptedPayload = z.infer<typeof Phase3CycleAdoptedPayloadSchema>;
export type Phase3CycleFinishedPayload = z.infer<typeof Phase3CycleFinishedPayloadSchema>;
export type Phase3ModelRequestPayload = z.infer<typeof Phase3ModelRequestPayloadSchema>;
export type Phase3ToolRunPayload = z.infer<typeof Phase3ToolRunPayloadSchema>;
