import { z } from "zod";
import { TraceIdSchema } from "../common/ids.js";
import { JsonValueSchema, extensibleJsonObject } from "../common/json-value.js";

/**
 * 错误使用稳定机器码，客户端不得解析错误文案（docs/phase-1-reference.md）。
 * details 只能包含安全、结构化和可序列化的信息（JsonValue）；
 * 不返回堆栈、SQL、密钥或本地绝对路径。
 */
export const ErrorCodeSchema = z.enum([
  "invalid_message",
  "unsupported_version",
  "unauthorized",
  "deadline_exceeded",
  "backpressure",
  "not_ready",
  "internal_error",
]);

export const ErrorEnvelopeSchema = extensibleJsonObject({
  code: ErrorCodeSchema,
  message: z.string().min(1).max(4096),
  retryable: z.boolean(),
  details: JsonValueSchema.optional(),
  traceId: TraceIdSchema,
});

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
