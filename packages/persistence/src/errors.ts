/**
 * Persistence 稳定错误模型（phase-1-build-guide.md §9.1；P2 文档 §5.1）。
 *
 * 跨 Worker RPC 边界只传播安全码 + 稳定消息 + 可重试性；
 * SQL 文本、数据库绝对路径和原始 Payload 绝不进入错误对象或日志。
 */

export const PERSISTENCE_ERROR_CODES = [
  /** Client/Worker 不可用（Worker 崩溃、未初始化、通道关闭）。 */
  "unavailable",
  /** Client 已关闭，拒绝新请求。 */
  "closed",
  /** 请求超过 Deadline。 */
  "deadline_exceeded",
  /** 请求未通过 Schema 校验或语义检查。 */
  "invalid_request",
  /** 尚未执行 migrate()，业务操作被拒绝。 */
  "not_migrated",
  /** Session 不存在（需先 ensureSession）。 */
  "session_not_found",
  /** 同一 Session ID 的元数据与既有记录冲突。 */
  "session_conflict",
  /** Session Record 未通过 Schema 校验。 */
  "record_invalid",
  /** 读到未知 schemaVersion，拒绝盲转当前类型。 */
  "record_version_unknown",
  /** 聚合序号冲突（重复或倒退）。 */
  "record_conflict",
  /** Signal Watermark 只能前进。 */
  "watermark_regression",
  /** 服务端序号只能前进。 */
  "seq_regression",
  /** 同 Key 不同请求摘要的幂等冲突。 */
  "idempotency_conflict",
  /** Scene Payload 未通过校验或与入参不一致。 */
  "scene_invalid",
  /** Scene 约束冲突（如 cycle 已提交）。 */
  "scene_conflict",
  /** Outbox 消息未通过校验。 */
  "outbox_invalid",
  /** 状态转换不满足条件（如非本 Lease 持有者）。 */
  "not_claimed",
  /** SQLite Busy/Locked（可重试）。 */
  "database_busy",
  /** Migration 注册表非法（版本缺口/重复/降级）。 */
  "migration_invalid",
  /** 受控检查点观察器主动中止（仅测试装配会触发）。 */
  "checkpoint_aborted",
  /** 已应用 Migration 的 checksum 与当前定义不一致。 */
  "migration_checksum_mismatch",
  /** Worker 内部未分类错误（细节只进 stderr，不跨边界）。 */
  "internal",
] as const;

export type PersistenceErrorCode = (typeof PERSISTENCE_ERROR_CODES)[number];

const RETRYABLE_CODES: ReadonlySet<PersistenceErrorCode> = new Set([
  "unavailable",
  "deadline_exceeded",
  "database_busy",
]);

export function isRetryableCode(code: PersistenceErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

/** 跨 RPC 边界的安全错误形态（P2 文档 §5.1 PersistenceRpcResponse.error）。 */
export interface SafePersistenceError {
  readonly code: PersistenceErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export interface PersistenceErrorOptions {
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

/** 主线程抛出的持久化错误；safe 字段是可跨边界传播的形态。 */
export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;
  readonly retryable: boolean;

  constructor(code: PersistenceErrorCode, message: string, options?: PersistenceErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PersistenceError";
    this.code = code;
    this.retryable = options?.retryable ?? isRetryableCode(code);
  }

  get safe(): SafePersistenceError {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

/** 把未知异常折叠为安全错误：已知 PersistenceError 原样透出，其余归为 internal。 */
export function toSafePersistenceError(error: unknown): SafePersistenceError {
  if (error instanceof PersistenceError) {
    return error.safe;
  }
  return {
    code: "internal",
    message: "persistence worker failed",
    retryable: false,
  };
}
