/**
 * W3C Trace Context `traceparent` 的严格解析与格式化（docs/phase-1-reference.md）。
 *
 * 只支持 version `00` 的标准字段宽度；解析失败的唯一结果是 `null`——
 * HTTP 边界收到非法 `traceparent` 时必须丢弃并由调用方创建新 Trace，
 * 绝不能原样透传（docs/phase-1-reference.md）。
 */

export interface ParsedTraceparent {
  /** 32 位小写十六进制，非全零。 */
  traceId: string;
  /** 16 位小写十六进制，非全零。 */
  spanId: string;
  /** 0–255 的原始 trace-flags 字节（bit 0 = sampled）。 */
  traceFlags: number;
}

const VERSION = "00";
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const TRACE_FLAGS_PATTERN = /^[0-9a-f]{2}$/;

function isAllZeroHex(value: string): boolean {
  return /^[0]+$/.test(value);
}

/**
 * 解析 `traceparent` 头。以下情况一律返回 `null`：
 * 非 4 个字段、version 非 `00`、Trace/Span ID 全零、含非小写十六进制、
 * 字段宽度错误、flags 非法、额外字段或任何空白。
 */
export function parseTraceparent(value: string): ParsedTraceparent | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parts = value.split("-");
  if (parts.length !== 4) {
    return null;
  }
  const version = parts[0];
  const traceId = parts[1];
  const spanId = parts[2];
  const traceFlags = parts[3];
  if (
    version === undefined ||
    traceId === undefined ||
    spanId === undefined ||
    traceFlags === undefined
  ) {
    return null;
  }
  if (version !== VERSION) {
    return null;
  }
  if (!TRACE_ID_PATTERN.test(traceId) || isAllZeroHex(traceId)) {
    return null;
  }
  if (!SPAN_ID_PATTERN.test(spanId) || isAllZeroHex(spanId)) {
    return null;
  }
  if (!TRACE_FLAGS_PATTERN.test(traceFlags)) {
    return null;
  }
  return { traceId, spanId, traceFlags: Number.parseInt(traceFlags, 16) };
}

/**
 * 格式化为规范 `traceparent`：全小写、version `00`、flags 两位十六进制。
 * 输入不符合 W3C 约束时抛出 RangeError（这是调用方编程错误，不是协议输入）。
 */
export function formatTraceparent(value: ParsedTraceparent): string {
  if (
    typeof value.traceId !== "string" ||
    !TRACE_ID_PATTERN.test(value.traceId) ||
    isAllZeroHex(value.traceId)
  ) {
    throw new RangeError("traceId must be 32 non-zero lowercase hex characters");
  }
  if (
    typeof value.spanId !== "string" ||
    !SPAN_ID_PATTERN.test(value.spanId) ||
    isAllZeroHex(value.spanId)
  ) {
    throw new RangeError("spanId must be 16 non-zero lowercase hex characters");
  }
  if (
    typeof value.traceFlags !== "number" ||
    !Number.isInteger(value.traceFlags) ||
    value.traceFlags < 0 ||
    value.traceFlags > 0xff
  ) {
    throw new RangeError("traceFlags must be an integer in [0, 255]");
  }
  const flags = value.traceFlags.toString(16).padStart(2, "0");
  return `${VERSION}-${value.traceId}-${value.spanId}-${flags}`;
}
