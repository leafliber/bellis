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

/**
 * 内容级脱敏（Gate 3 重开评审修复 1 + 复审/三审/四审修复）：
 * Error.message/stack 与任意嵌入字符串可能携带凭证原值（如异常消息回显
 * `Authorization: …` 头、嵌套序列化的转义 JSON 片段），字段名匹配无法
 * 覆盖自由文本，必须在字符串内容层清理。两条规则：
 *
 * 1. 敏感键值：名称匹配**复用字段级的同一份规范化敏感名称集合**
 *    （SENSITIVE_LOG_FIELD_NAMES → canonicalFieldName），且名称字符间
 *    允许任意非字母数字、非换行填充——与 canonicalFieldName「移除全部
 *    非字母数字」的语义对齐（`author.ization`/`auth/orization`/`api.key`
 *    与常见写法同形）；名称与 `:`/`=` 之间的填充任意长（嵌套
 *    JSON.stringify 每层使键关闭引号前的反斜杠序列翻倍再增一，
 *    1→3→7→…，不能按固定层数枚举）；值**整段到行尾**替换——单词级
 *    匹配在空格/分号/逗号/引号处停止，多片段值（多段 Cookie、未知
 *    scheme、Digest auth-param、`credentials=alice s3cret…` 多词值）
 *    必然残留尾段，只有整段才安全（复审/三审教训）。
 * 2. 裸 scheme 凭证（`Bearer/Basic/Digest…`，无键名前缀）：scheme 后
 *    整段到行尾替换——多片段 auth-param 同样只有整段才安全。
 * 与路径清理同一取舍：过度替换只损失可读性，绝不泄露原值。名称内外的
 * 填充绝不含换行（`\n`/`\r`）与字母数字——不跨行拼接名称、不吞并相邻
 * 日志行、不跨单词拼名。
 */

/** 规范名的文本形态：字符间允许任意非字母数字、非换行填充。 */
function flexibleNamePattern(canonicalName: string): string {
  return canonicalName.split("").join("[^\\nA-Za-z0-9\\r]*");
}

/** 长名在前，避免带填充的短名（如 `token`）先匹配截断长名。 */
function buildNameAlternation(canonicalNames: readonly string[]): string {
  return canonicalNames
    .toSorted((a, b) => b.length - a.length)
    .map(flexibleNamePattern)
    .join("|");
}

const SENSITIVE_TEXT_CANONICAL_NAMES: readonly string[] = [...SENSITIVE_CANONICAL_NAMES];

// 名称与 `:`/`=` 之间的填充同样允许任意非字母数字、非换行（吸收任意
// 深度的转义引号/反斜杠序列），但必须**懒惰**锚定名称后的第一个分隔符：
// 贪婪回溯会锚定到纯标点值内部的最后一个 `=`/`:`，把凭证保留进捕获组
// （`token: -.___=` 反例）。值整段到行尾且不含 `\r`（保留 CRLF）。
const SENSITIVE_KEY_VALUE_PATTERN = new RegExp(
  `(\\b(?:${buildNameAlternation(SENSITIVE_TEXT_CANONICAL_NAMES)})[^\\nA-Za-z0-9\\r]*?[:=][ \\t]*)([^\\n\\r]*)`,
  "gi",
);

const SCHEME_CREDENTIAL_PATTERN =
  /(\b(?:bearer|basic|digest|hoba|mutual|negotiate|ntlm|startuptoken)[ \t]+)[^\n\r]*/gi;

/** 优先级：敏感键值整段 → 裸 scheme 整段（见上方注释）。 */
function scrubSensitiveText(text: string): string {
  return text
    .replace(SENSITIVE_KEY_VALUE_PATTERN, "$1[redacted]")
    .replace(SCHEME_CREDENTIAL_PATTERN, "$1[redacted]");
}

/** 所有进入日志输出的字符串的唯一出口：先截断（限定清理开销），再内容级脱敏。 */
function sanitizeLogText(value: string): string {
  return scrubSensitiveText(truncateString(value));
}

/** 绝对路径（含堆栈中的文件位置）替换为 `<path>`，本地日志保留脱敏 Stack。 */
function scrubPaths(text: string): string {
  // 匹配绝对路径形态：Unix `/…`、Windows 盘符 `C:\…` 或 UNC `\\…`。
  // 匹配起点须在词边界之后（行首/空白/引号/括号等），因此 `and/or`、
  // `2026/08/20` 这类单词内分隔符不受影响。三种形态：
  //  - 多段路径：段内允许空格，引号/尖括号/换行终止，`)` 之前结束以保留堆栈帧；
  //  - 单段路径但以 `:line:column` 收尾（V8 堆栈位置）：允许段内空格，括号/
  //    引号/换行终止——`/secret file.ts:1:1`、`C:\secret file.ts:2:2` 整体
  //    替换，含空格文件名不残留后缀（评审 3-P2-2）；
  //  - 其余单段绝对路径（`/secret.ts`）：匹配到最近的空白/引号/括号为止，
  //    不跨越空格——普通文本中的 `a / b` 不会被吞掉。
  // 同一行多个路径可能被并成一个匹配——过度替换只损失可读性，不泄露路径。
  return text.replace(
    /(?<=^|[\s"'`()\]{}<>,;:=])(?:[A-Za-z]:)?(?:[\\/][^\n'"<>]*[\\/][^\n'"<>)]*|[\\/][^\n'"<>()]*:\d+:\d+|[\\/][^\s\n'"<>()]+)/g,
    "<path>",
  );
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
 * - Getter 抛错 → "[getter-error]"；超长字符串与超大对象截断；
 * - 未预见的敌意陷阱 → "[redaction-error]"。公开入口对任何输入都不抛错。
 */
export function redactValue(value: unknown): unknown {
  return safeRedactNode(value, new WeakSet<object>(), 0);
}

/**
 * redactNode 的安全包装：任何未预见的陷阱（如 Proxy 的 getPrototypeOf
 * 陷阱会让 instanceof 抛错）降级为 "[redaction-error]"，绝不向上传播。
 * 所有递归调用点都必须经过本包装，嵌套敌意对象才同样受保护。
 */
function safeRedactNode(value: unknown, ancestors: WeakSet<object>, depth: number): unknown {
  try {
    return redactNode(value, ancestors, depth);
  } catch {
    return "[redaction-error]";
  }
}

function redactNode(value: unknown, ancestors: WeakSet<object>, depth: number): unknown {
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return sanitizeLogText(value);
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
      return sanitizeLogText(node.toString());
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
  let length: number;
  try {
    length = items.length;
  } catch {
    ancestors.delete(items);
    return ["[getter-error]"];
  }
  for (let i = 0; i < length; i += 1) {
    if (out.length >= MAX_OBJECT_KEYS) {
      out.push(`[truncated ${length - out.length} more items]`);
      break;
    }
    // 数组索引可能是抛错的访问器（或 Proxy get 陷阱）：逐项保护，其余元素保留。
    let item: unknown;
    try {
      item = items[i];
    } catch {
      out.push("[getter-error]");
      continue;
    }
    out.push(safeRedactNode(item, ancestors, depth + 1));
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
    defineField(out, key, safeRedactNode(propertyValue, ancestors, depth + 1));
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
    // 自有属性值可能是嵌套敌意对象：递归必须经过 safeRedactNode，
    // 否则公开 serializeErrorForLog 会被属性值内部的陷阱穿透（评审 3-P2-1）。
    defineField(out, key, safeRedactNode(propertyValue, seen, depth + 1));
  }
  let cause: unknown;
  try {
    cause = (error as { cause?: unknown }).cause;
  } catch {
    cause = undefined;
  }
  if (cause !== undefined && cause !== null && depth < MAX_ERROR_CAUSE_DEPTH) {
    // cause 同样可能是敌意对象，与自有属性走同一保护（评审 3-P2-1）。
    defineField(out, "cause", safeRedactNode(cause, seen, depth + 1));
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
    return sanitizeLogText(raw);
  }
  try {
    return sanitizeLogText(String(raw));
  } catch {
    return stringFallback;
  }
}
