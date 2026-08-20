import pino from "pino";
import type { LogFields, LogLevel, LoggerPort } from "../logger.js";
import { isSensitiveFieldName, redactValue } from "./redaction.js";

/**
 * Pino Logger Factory：实现 Gate 1 的 LoggerPort（p3-observability-testkit.md §7.1）。
 *
 * - 每条日志包含 time、level、service、version、event；
 * - 所有字段（含子 Logger 固定字段）先经过字段级 Redaction 再交给 Pino，
 *   `service/version/event` 等受保护键无法被调用方覆盖；
 * - Error（含 cause 链）安全序列化并脱敏；
 * - 写入失败时进入降级模式：静默丢弃后续日志，绝不递归写日志或把异常
 *   抛回 Runtime 关键路径；
 * - 通过注入 Destination 测试，不依赖读取控制台文本。
 */

export interface LoggerDestination {
  /** 接收一行完整 JSON 日志（含换行符）。实现不得抛错，抛错即触发降级。 */
  write(line: string): void;
}

export interface LoggerOptions {
  service: string;
  version: string;
  level: LogLevel;
  destination?: LoggerDestination;
}

/** 受保护键：由工厂或 Pino 注入，调用方字段与子 Logger 字段不得覆盖。 */
const PROTECTED_FIELD_KEYS: ReadonlySet<string> = new Set([
  "service",
  "version",
  "event",
  "level",
  "time",
  "pid",
  "hostname",
  "msg",
  "v",
]);

const REDACTED = "[redacted]";

type EmitFn = (fields: Record<string, unknown>, event: string) => void;

export function createPinoLogger(options: LoggerOptions): LoggerPort {
  if (typeof options.service !== "string" || options.service.length === 0) {
    throw new RangeError("LoggerOptions.service must be a non-empty string");
  }
  if (typeof options.version !== "string" || options.version.length === 0) {
    throw new RangeError("LoggerOptions.version must be a non-empty string");
  }
  const destination: LoggerDestination = options.destination ?? {
    write: (line) => {
      process.stdout.write(line);
    },
  };

  let degraded = false;
  const stream = {
    write(chunk: string) {
      if (degraded) {
        return;
      }
      try {
        destination.write(chunk);
      } catch {
        degraded = true;
      }
    },
  };

  const pinoLogger = pino(
    {
      level: options.level,
      base: { service: options.service, version: options.version },
      messageKey: "event",
      formatters: { level: (label) => ({ level: label }) },
      // pino 默认的 err serializer 会把任何含 message 字符串的对象视为
      // error-like 并改写 message/stack（messageWithCauses），破坏预净化
      // 结构；字段已由 redactValue 完成安全序列化，这里用恒等函数关闭。
      serializers: { err: (value) => value },
    },
    stream,
  );

  function sanitizeFields(fields?: LogFields): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (fields === undefined) {
      return out;
    }
    for (const [key, value] of Object.entries(fields)) {
      if (PROTECTED_FIELD_KEYS.has(key)) {
        continue;
      }
      Object.defineProperty(out, key, {
        // 顶层字段同样要做键级敏感匹配：redactValue 只处理值，
        // 顶层键不会经过 redactRecord 的键检查。
        value: isSensitiveFieldName(key) ? REDACTED : redactValue(value),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }

  function bindLogger(baseFields: Record<string, unknown>): LoggerPort {
    return {
      log: (level: LogLevel, event: string, fields?: LogFields) => {
        if (degraded) {
          return;
        }
        const safeUserFields = sanitizeFields(fields);
        const merged = { ...baseFields, ...safeUserFields };
        try {
          const log = pinoLogger[level] as EmitFn;
          // pino 方法依赖实例 this，必须显式绑定调用。
          log.call(pinoLogger, merged, event);
        } catch {
          degraded = true;
        }
      },
      child: (fields: LogFields) => bindLogger({ ...baseFields, ...sanitizeFields(fields) }),
    };
  }

  return bindLogger({});
}
