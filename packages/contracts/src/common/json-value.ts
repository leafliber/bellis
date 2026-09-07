import { z } from "zod";

/**
 * 递归 JSON 值 Schema：所有跨 JSON/WS/持久化边界的开放字段（payload、
 * details、arguments、content、intent）的唯一类型。
 *
 * z.unknown() 会接受 bigint、函数、Symbol 等无法 JSON 序列化的值，
 * 导致「通过 Schema 校验的对象在 JSON.stringify 时抛错」。凡是会进入
 * REST、WebSocket 或 SQLite JSON 列的字段都必须使用本 Schema，
 * 保证校验通过 ⇔ 可无损 JSON 序列化。
 *
 * 危险键无损保留：JSON 允许 "__proto__" 作为普通键名（JSON.parse 会
 * 生成自有数据属性，JSON.stringify 也会如实输出），但 Zod 4 的
 * z.record / z.object 重建输出对象时为防原型污染会静默跳过该键，
 * 使合法 payload 在 parse 后丢失字段。这里在进入 Zod 前把危险自有键
 * 前缀转义为 "\u0000__proto__"（对转义前缀本身的键再加一层前缀保持
 * 单射），解析完成后按原顺序用 defineProperty 还原，parse 输出与
 * 输入逐字节等价（含键序）。无危险键时转义与还原都走零拷贝快路径。
 * 转义/还原对 z.toJSONSchema 不可见，双 dialect 生成物不受影响。
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** 转义前缀 NUL：合法 JSON 键可以是任意 Unicode，NUL 极少冲突且单射可还原。 */
const ESCAPE_PREFIX = "\u0000";
const DANGEROUS_KEY = "__proto__";

function isDangerousKey(key: string): boolean {
  return key === DANGEROUS_KEY || key.startsWith(ESCAPE_PREFIX);
}

/**
 * 把输入对象的自有危险键替换为带 NUL 前缀的安全键，供 Zod 重建时保留。
 * 非对象与无危险键的输入原样返回（快路径零拷贝）；可枚举 Symbol 键
 * 随拷贝保留，维持 z.record 对非字符串键的拒绝语义。
 */
function escapeDangerousOwnKeys(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return input;
  }
  const source = input as Record<string, unknown>;
  const keys = Object.keys(source);
  if (!keys.some(isDangerousKey)) {
    return input;
  }
  const escaped: Record<string, unknown> = {};
  for (const key of keys) {
    escaped[isDangerousKey(key) ? ESCAPE_PREFIX + key : key] = source[key];
  }
  const symbolSource = input as Record<symbol, unknown>;
  for (const symbol of Object.getOwnPropertySymbols(input)) {
    if (Object.prototype.propertyIsEnumerable.call(input, symbol)) {
      Object.defineProperty(escaped, symbol, {
        value: symbolSource[symbol],
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return escaped;
}

/**
 * parse 后按原键序还原转义键：delete 全部自有键后按快照顺序逐个
 * defineProperty 回填（直接 delete+defineProperty 单键会把还原键挪到末尾，
 * 破坏 JSON.stringify 的键序等价）。仅在有转义键时才重建。
 */
function restoreEscapedOwnKeys(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return true;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!keys.some((key) => key.startsWith(ESCAPE_PREFIX))) {
    return true;
  }
  const snapshot = keys.map((key) => [key, record[key]] as const);
  for (const key of keys) {
    delete record[key];
  }
  for (const [key, propertyValue] of snapshot) {
    Object.defineProperty(
      record,
      key.startsWith(ESCAPE_PREFIX) ? key.slice(ESCAPE_PREFIX.length) : key,
      { value: propertyValue, enumerable: true, writable: true, configurable: true },
    );
  }
  return true;
}

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z
    .preprocess(
      escapeDangerousOwnKeys,
      z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.null(),
        z.array(JsonValueSchema),
        z.record(z.string(), JsonValueSchema),
      ]),
    )
    .refine(restoreEscapedOwnKeys),
);

/**
 * 可前向扩展的协议对象（docs/reference/phase-1.md，原规范对“未识别的可选 Payload
 * 字段由 Schema 策略明确处理」的统一答案）。
 *
 * 未知扩展键以 JsonValueSchema 作为 catch-all 校验：扩展值必须是 JSON 值，
 * 因此「通过 Schema 校验 ⇔ 可无损 JSON 序列化」对未知键同样成立。生成的
 * JSON Schema 为 additionalProperties: JsonValueSchema（递归 $ref 定义），
 * Zod / Ajv2020 / AjvDraft7 三方判定一致。
 *
 * 对象自身的危险扩展键（如 "__proto__"）同样经转义/还原无损保留
 * （见顶部说明）。不使用 z.looseObject：其未知键是完全不受约束的
 * unknown，生成物 additionalProperties:{} 无法拒绝 bigint 等非 JSON 值，
 * 校验通过的对象仍可能在 JSON.stringify 时抛错。需要闭合的规范形态对象
 * 请用 z.strictObject。
 */
export function extensibleJsonObject<T extends z.ZodRawShape>(shape: T) {
  return z
    .preprocess(escapeDangerousOwnKeys, z.object(shape).catchall(JsonValueSchema))
    .refine(restoreEscapedOwnKeys);
}

/**
 * 无危险键转义的可扩展对象：仅用于 z.discriminatedUnion 成员（成员必须是
 * ZodObject 类型，管道包装不可作为成员）。此时危险键的转义/还原由外层
 * 包裹整个判别联合的 preprocess/refine 统一负责（见 control-payload.ts）。
 */
export function rawExtensibleJsonObject<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).catchall(JsonValueSchema);
}

/**
 * 键名开放的 JSON 记录字段（如 tool-call 的 arguments）：键与值都必须
 * 无损保留。z.record 会静默丢弃 "__proto__" 键名，这里与
 * extensibleJsonObject 相同地转义/还原。
 */
export function extensibleJsonRecord<V extends z.ZodType<JsonValue>>(valueSchema: V) {
  return z
    .preprocess(escapeDangerousOwnKeys, z.record(z.string(), valueSchema))
    .refine(restoreEscapedOwnKeys);
}

export { escapeDangerousOwnKeys, restoreEscapedOwnKeys };
