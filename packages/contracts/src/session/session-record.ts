import { z } from "zod";
import { DecimalStringSchema } from "../common/decimal-string.js";
import { TraceIdSchema, UuidSchema } from "../common/ids.js";
import { JsonValueSchema } from "../common/json-value.js";

/**
 * Session Record：追加式会话记录，服务于审计、恢复和调试
 * （architecture-plan.md §16）。
 * payload 写入前必须通过对应 recordType 的版本化 Schema；
 * 查询端读到未知 schemaVersion 时必须返回明确兼容性错误。
 */
export const SessionRecordSchema = z.looseObject({
  schemaVersion: z.literal(1),
  recordId: UuidSchema,
  sessionId: UuidSchema,
  recordType: z.string().min(1).max(64),
  aggregateId: z.string().min(1).max(128).optional(),
  aggregateSeq: DecimalStringSchema.optional(),
  traceId: TraceIdSchema,
  /** Unix epoch milliseconds，只用于审计与展示，不决定恢复顺序。 */
  occurredAtMs: z.number().int().nonnegative(),
  payload: JsonValueSchema,
});

export type SessionRecord = z.infer<typeof SessionRecordSchema>;
