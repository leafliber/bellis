import pino from "pino";
import type { LogFields, LogLevel, LoggerPort } from "../logger.js";
import { defineField, isSensitiveFieldName, redactValue } from "./redaction.js";

/**
 * Pino Logger Factory：实现 Gate 1 的 LoggerPort（docs/phase-1-reference.md）。
 *
 * - 每条日志包含 time、level、service、version、event；
 * - 所有字段（含子 Logger 固定字段）先经过字段级 Redaction 再交给 Pino，
 *   `service/version/event` 等受保护键无法被调用方覆盖；
 * - Error（含 cause 链）安全序列化并脱敏；
 * - 任何路径（含抛错的 Getter、Proxy 陷阱、序列化失败）都不会把异常抛回
 *   业务调用方；写入失败时进入降级模式，静默丢弃后续日志，绝不递归写日志；
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
    // 用 Object.keys 而不是 Object.entries：entries 会立即执行全部 Getter，
    // 任何一个抛错都会把异常传播回业务路径。
    let keys: string[];
    try {
      keys = Object.keys(fields);
    } catch {
      defineField(out, "[fields]", "[unenumerable]");
      return out;
    }
    for (const key of keys) {
      if (PROTECTED_FIELD_KEYS.has(key)) {
        continue;
      }
      let value: unknown;
      try {
        value = (fields as Record<string, unknown>)[key];
      } catch {
        defineField(out, key, "[getter-error]");
        continue;
      }
      // 顶层字段同样要做键级敏感匹配：redactValue 只处理值，
      // 顶层键不会经过 redactRecord 的键检查。
      defineField(out, key, isSensitiveFieldName(key) ? REDACTED : redactValue(value));
    }
    return out;
  }

  function bindLogger(baseFields: Record<string, unknown>): LoggerPort {
    return {
      log: (level: LogLevel, event: string, fields?: LogFields) => {
        if (degraded) {
          return;
        }
        let safeUserFields: Record<string, unknown>;
        try {
          safeUserFields = sanitizeFields(fields);
        } catch {
          safeUserFields = { "[fields]": "[sanitization-failed]" };
        }
        try {
          const log = pinoLogger[level] as EmitFn;
          // pino 方法依赖实例 this，必须显式绑定调用。
          log.call(pinoLogger, { ...baseFields, ...safeUserFields }, event);
        } catch {
          degraded = true;
        }
      },
      child: (fields: LogFields) => {
        try {
          return bindLogger({ ...baseFields, ...sanitizeFields(fields) });
        } catch {
          // 子字段净化失败时降级为不携带新字段的子 Logger，绝不抛回调用方。
          return bindLogger({ ...baseFields });
        }
      },
    };
  }

  return bindLogger({});
}
