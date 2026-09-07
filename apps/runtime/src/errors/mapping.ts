import { createHash } from "node:crypto";
import type { ErrorCode } from "@bellis/contracts";
import { PersistenceError, toSafePersistenceError } from "@bellis/persistence";
import { isRetryableCode } from "@bellis/persistence";
import type { LoggerPort } from "@bellis/observability";
import { TransportProtocolViolationError } from "@bellis/transport";
import { ZodError } from "zod";

/**
 * 集中错误映射（docs/phase-1-reference.md）：把 Auth/Transport/Persistence/Application
 * 错误转换为 Contracts `ErrorEnvelope`，并为 REST 选择稳定状态码。
 *
 * 规则：
 * - `message` 供人阅读，客户端不得当机器码解析；机器码只有 `code`。
 * - `details` 只含安全、JSON-safe、低敏字段；绝不包含 Stack、SQL、
 *   Token、Cookie 或绝对路径。
 * - 原始错误保留在本地日志（cause 链），不返回给客户端。
 */

/** 应用层错误：携带稳定 ErrorEnvelope 机器码，供 Route/WS 统一映射。 */
export class ApplicationError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly status: number;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { retryable?: boolean; status?: number; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? {} : { cause: options.cause });
    this.name = "ApplicationError";
    this.code = code;
    this.retryable = options?.retryable ?? DEFAULT_RETRYABLE.has(code);
    this.status = options?.status ?? DEFAULT_STATUS.get(code) ?? 500;
  }
}

const DEFAULT_RETRYABLE = new Set<ErrorCode>(["backpressure", "not_ready"]);
const DEFAULT_STATUS = new Map<ErrorCode, number>([
  ["invalid_message", 400],
  ["unsupported_version", 400],
  ["unauthorized", 401],
  ["deadline_exceeded", 504],
  ["backpressure", 503],
  ["not_ready", 503],
  ["internal_error", 500],
]);

/** Persistence 错误码 → ErrorEnvelope 机器码 + HTTP 状态。 */
const PERSISTENCE_CODE_MAP: ReadonlyMap<string, { code: ErrorCode; status: number }> = new Map([
  ["not_migrated", { code: "not_ready", status: 503 }],
  ["storage_not_ready", { code: "not_ready", status: 503 }],
  ["unavailable", { code: "not_ready", status: 503 }],
  ["closed", { code: "not_ready", status: 503 }],
  ["deadline_exceeded", { code: "deadline_exceeded", status: 504 }],
  ["database_busy", { code: "backpressure", status: 503 }],
  ["invalid_request", { code: "invalid_message", status: 400 }],
  ["session_not_found", { code: "unauthorized", status: 401 }],
  ["session_conflict", { code: "invalid_message", status: 409 }],
  ["record_invalid", { code: "invalid_message", status: 400 }],
  ["record_conflict", { code: "invalid_message", status: 409 }],
  ["watermark_regression", { code: "invalid_message", status: 409 }],
  ["seq_regression", { code: "invalid_message", status: 409 }],
  ["idempotency_conflict", { code: "invalid_message", status: 409 }],
  ["scene_invalid", { code: "invalid_message", status: 400 }],
  ["scene_conflict", { code: "invalid_message", status: 409 }],
  ["outbox_invalid", { code: "invalid_message", status: 400 }],
  ["checkpoint_aborted", { code: "internal_error", status: 500 }],
  ["migration_invalid", { code: "internal_error", status: 500 }],
  ["migration_checksum_mismatch", { code: "internal_error", status: 500 }],
]);

export interface MappedErrorEnvelope {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly status: number;
}

function zodMessage(error: ZodError): string {
  const first = error.issues[0];
  if (first === undefined) {
    return "request payload failed schema validation";
  }
  const path = first.path.length > 0 ? first.path.join(".") : "(root)";
  return `request payload failed schema validation at ${path}`;
}

/**
 * 将任意错误折叠为安全的 ErrorEnvelope 内容。
 * `log` 收到带 cause 的本地诊断（脱敏由 Logger 的字段级 Redaction 兜底）。
 */
export function mapErrorToEnvelope(
  error: unknown,
  traceId: string,
  log?: LoggerPort,
): MappedErrorEnvelope {
  if (error instanceof ApplicationError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      status: error.status,
    };
  }
  if (error instanceof ZodError) {
    return { code: "invalid_message", message: zodMessage(error), retryable: false, status: 400 };
  }
  if (error instanceof PersistenceError) {
    const mapped = PERSISTENCE_CODE_MAP.get(error.code) ?? {
      code: "internal_error" as ErrorCode,
      status: 500,
    };
    log?.log("warn", "runtime_persistence_error", {
      code: error.code,
      retryable: isRetryableCode(error.code),
      traceId,
      error: error.message,
    });
    return {
      code: mapped.code,
      message: `persistence operation failed (${error.code})`,
      // not_ready / backpressure 语义上可重试；其余按客户端修复处理。
      retryable: mapped.code === "not_ready" || mapped.code === "backpressure",
      status: mapped.status,
    };
  }
  if (error instanceof TransportProtocolViolationError) {
    return {
      code: "internal_error",
      message: "outbound protocol assembly failed",
      retryable: false,
      status: 500,
    };
  }
  const safe = toSafePersistenceError(error);
  log?.log("error", "runtime_unexpected_error", {
    traceId,
    safeCode: safe.code,
    error: error instanceof Error ? error.message : "unknown",
  });
  return {
    code: "internal_error",
    message: "internal runtime error",
    retryable: false,
    status: 500,
  };
}

/** 新建 ErrorEnvelope JSON（Wire 形态，含 traceId）。 */
export function toErrorEnvelopeJson(
  mapped: MappedErrorEnvelope,
  traceId: string,
): {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  traceId: string;
} {
  return { code: mapped.code, message: mapped.message, retryable: mapped.retryable, traceId };
}

/** 请求指纹：稳定请求部分的 SHA-256（幂等键冲突检测用，不含生成 ID）。bigint 序列化为十进制字符串。 */
export function stableRequestFingerprint(parts: ReadonlyArray<unknown>): string {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify(parts, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString(10) : value,
    ),
  );
  return hash.digest("hex");
}
