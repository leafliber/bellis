/**
 * 最小 Logger Port（Gate 1 空壳，docs/phase-1-reference.md）。
 * Port 只描述能力；P3 交付 Pino 实现与字段级 Redaction。
 * 字段约定：event 必填；trace/session/cycle/scene 标识存在时必须携带；
 * 禁止把 Cookie、启动 Token、授权头或未经处理的隐私数据写入日志。
 */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export type LogFields = Readonly<Record<string, unknown>>;

export interface LoggerPort {
  log(level: LogLevel, event: string, fields?: LogFields): void;
  /** 派生绑定固定字段的子 Logger（如 trace 上下文）。 */
  child(fields: LogFields): LoggerPort;
}

function noopLog(): void {}

/** No-op 实现：生产装配的默认占位，P3 替换为 Pino。 */
export function createNoopLogger(): LoggerPort {
  const logger: LoggerPort = {
    log: noopLog,
    child: () => logger,
  };
  return logger;
}
