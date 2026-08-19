import { z } from "zod";

/**
 * 实体 ID 使用 UUID，不从时间推断顺序（phase-1-build-guide.md §6.2）。
 * 接受任意大小写（输入宽松），Runtime 自身只产生小写规范形式。
 * 模式必须保持可映射到 JSON Schema `pattern`（ECMA-262，无 flags），
 * 因此大小写用显式字符类而不是 /i 标志表达。
 */
export const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const UuidSchema = z.string().regex(UUID_PATTERN, {
  message: "must be a UUID",
});

/** W3C Trace Context 的 traceId：32 位小写十六进制。 */
export const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;

export const TraceIdSchema = z.string().regex(TRACE_ID_PATTERN, {
  message: "must be 32 lowercase hex characters (W3C trace-id)",
});

/** W3C Trace Context 的 spanId：16 位小写十六进制。可选传播，不替代业务 ID。 */
export const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;

export const SpanIdSchema = z.string().regex(SPAN_ID_PATTERN, {
  message: "must be 16 lowercase hex characters (W3C parent/span-id)",
});
