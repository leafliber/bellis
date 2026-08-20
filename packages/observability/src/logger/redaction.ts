/**
 * 字段级 Redaction（p3-observability-testkit.md §7.2）。
 *
 * 目标：敏感字段的原值绝不出现在日志序列化输出的任何位置，同时保证
 * 循环引用、Getter 抛错、超深对象、超大字段与 bigint 都被稳定处理，
 * 且全程不修改调用方传入的对象。
 *
 * 匹配规则：字段名大小写不敏感、忽略非字母数字分隔符
 * （`Authorization`/`authorization`/`api_key`/`API-KEY` 视为同一字段），
 * 递归作用于对象、数组、Error 及其 cause 链。
 */

export const SENSITIVE_LOG_FIELD_NAMES: readonly string[] = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "token",
  "startupToken",
  "sessionToken",
  "accessToken",
  "refreshToken",
  "apiKey",
  "password",
  "secret",
  "credentials",
];

const REDACTED = "[redacted]";
const MAX_DEPTH = 8;
const MAX_STRING_LENGTH = 4096;
const MAX_OBJECT_KEYS = 128;
const MAX_ERROR_CAUSE_DEPTH = 3;

const SENSITIVE_CANONICAL_NAMES = new Set(SENSITIVE_LOG_FIELD_NAMES.map(canonicalFieldName));

/** 字段名规范化：小写并去除非字母数字字符，用于跨命名风格匹配。 */
export function canonicalFieldName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSensitiveFieldName(key: string): boolean {
  return SENSITIVE_CANONICAL_NAMES.has(canonicalFieldName(key));
}

/** 绝对路径（含堆栈中的文件位置）替换为 `<path>`，本地日志保留脱敏 Stack。 */
function scrubPaths(text: string): string {
  // 匹配绝对路径形态：Unix `/…`、Windows 盘符 `C:\…` 或 UNC `\\…`。
  // 路径内部允许空格；引号/尖括号/换行终止，`)` 之前结束以保留堆栈帧结构。
  // 同一行多个路径可能被并成一个匹配——过度替换只损失可读性，不泄露路径。
  return text.replace(/(?:[A-Za-z]:)?(?:\/|\\)[^\n'"<>]*[\\/][^\n'"<>)]*/g, "<path>");
}

function truncateString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_STRING_LENGTH)}…[truncated ${value.length - MAX_STRING_LENGTH} chars]`;
}

export function defineField(target: Record<string, unknown>, key: string, value: unknown): void {
  // defineProperty 而非赋值：`__proto__` 等危险键作为自有数据属性写入，
  // 不会触发原型 setter（与 contracts 的键转义策略同源）。
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * 递归净化任意值，返回可安全 JSON 序列化的新结构。
 * - 敏感字段 → "[redacted]"；bigint → 十进制字符串；
 * - 循环引用 → "[circular]"；超深 → "[depth-limit]"；
 * - Getter 抛错 → "[getter-error]"；超长字符串与超大对象截断。
 */
export function redactValue(value: unknown): unknown {
  return redactNode(value, new WeakSet<object>(), 0);
}

function redactNode(value: unknown, ancestors: WeakSet<object>, depth: number): unknown {
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return truncateString(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "undefined") {
    return value;
  }
  if (typeof value === "bigint") {
    // JSON.stringify 无法序列化 bigint，先转为十进制字符串。
    return value.toString();
  }
  if (typeof value === "symbol" || typeof value === "function") {
    return `[${typeof value}]`;
  }

  const node = value as object;
  if (depth >= MAX_DEPTH) {
    return "[depth-limit]";
  }
  if (ancestors.has(node)) {
    return "[circular]";
  }
  if (node instanceof Error) {
    return serializeErrorForLog(node, ancestors, depth);
  }
  if (Array.isArray(node)) {
    return redactArray(node, ancestors, depth);
  }
  if (node instanceof Date) {
    try {
      return node.toISOString();
    } catch {
      return "[invalid-date]";
    }
  }
  if (node instanceof RegExp) {
    try {
      return truncateString(node.toString());
    } catch {
      return "[regexp]";
    }
  }
  if (node instanceof Map || node instanceof Set) {
    try {
      return `${node.constructor.name}(${node.size})`;
    } catch {
      return node instanceof Map ? `[Map(${node.size})]` : `[Set(${node.size})]`;
    }
  }
  if (ArrayBuffer.isView(node)) {
    const view = node as { length?: number; byteLength?: number };
    return `[binary ${view.byteLength ?? view.length ?? 0} bytes]`;
  }
  return redactRecord(node, ancestors, depth);
}

function redactArray(
  items: readonly unknown[],
  ancestors: WeakSet<object>,
  depth: number,
): unknown[] {
  ancestors.add(items);
  const out: unknown[] = [];
  for (const item of items) {
    if (out.length >= MAX_OBJECT_KEYS) {
      out.push(`[truncated ${items.length - out.length} more items]`);
      break;
    }
    out.push(redactNode(item, ancestors, depth + 1));
  }
  ancestors.delete(items);
  return out;
}

function redactRecord(
  source: object,
  ancestors: WeakSet<object>,
  depth: number,
): Record<string, unknown> {
  ancestors.add(source);
  const out: Record<string, unknown> = {};
  // Proxy 的 ownKeys 陷阱可以抛错；键枚举失败时整体降级，不向调用方传播。
  let keys: string[];
  try {
    keys = Object.keys(source);
  } catch {
    ancestors.delete(source);
    return { "[unenumerable]": true };
  }
  let written = 0;
  for (const key of keys) {
    if (written >= MAX_OBJECT_KEYS) {
      defineField(out, "[truncated]", `${keys.length - written} more keys`);
      break;
    }
    written += 1;
    if (isSensitiveFieldName(key)) {
      defineField(out, key, REDACTED);
      continue;
    }
    let propertyValue: unknown;
    try {
      propertyValue = (source as Record<string, unknown>)[key];
    } catch {
      defineField(out, key, "[getter-error]");
      continue;
    }
    defineField(out, key, redactNode(propertyValue, ancestors, depth + 1));
  }
  ancestors.delete(source);
  return out;
}

/**
 * Error 的安全序列化：保留 name/message/stack（脱敏路径）、cause 链与
 * 自有可枚举属性（如 code），供本地诊断使用。name/message/stack/cause
 * 都可能是抛错的 Getter，全部逐项保护。
 */
export function serializeErrorForLog(
  error: Error,
  ancestors?: WeakSet<object>,
  depth = 0,
): Record<string, unknown> {
  const seen = ancestors ?? new WeakSet<object>();
  seen.add(error);
  const out: Record<string, unknown> = {};
  defineField(
    out,
    "name",
    safeReadString(() => error.name, "[getter-error]", "Error"),
  );
  defineField(
    out,
    "message",
    safeReadString(() => error.message, "[getter-error]", ""),
  );
  const stack = safeReadString(() => error.stack, "[getter-error]", "");
  if (stack !== "") {
    defineField(out, "stack", stack === "[getter-error]" ? stack : scrubPaths(stack));
  }
  let keys: string[];
  try {
    keys = Object.keys(error);
  } catch {
    keys = [];
  }
  for (const key of keys) {
    if (key === "name" || key === "message" || key === "stack") {
      continue;
    }
    if (isSensitiveFieldName(key)) {
      defineField(out, key, REDACTED);
      continue;
    }
    let propertyValue: unknown;
    try {
      propertyValue = (error as unknown as Record<string, unknown>)[key];
    } catch {
      defineField(out, key, "[getter-error]");
      continue;
    }
    defineField(out, key, redactNode(propertyValue, seen, depth + 1));
  }
  let cause: unknown;
  try {
    cause = (error as { cause?: unknown }).cause;
  } catch {
    cause = undefined;
  }
  if (cause !== undefined && cause !== null && depth < MAX_ERROR_CAUSE_DEPTH) {
    defineField(out, "cause", redactNode(cause, seen, depth + 1));
  }
  return out;
}

/**
 * 读取可能抛错的字符串属性：Getter 抛错返回 getterFallback，
 * String() 转换抛错（如 toString 抛错的对象值）返回 stringFallback。
 */
function safeReadString(
  read: () => unknown,
  getterFallback: string,
  stringFallback: string,
): string {
  let raw: unknown;
  try {
    raw = read();
  } catch {
    return getterFallback;
  }
  if (typeof raw === "string") {
    return truncateString(raw);
  }
  try {
    return truncateString(String(raw));
  } catch {
    return stringFallback;
  }
}
