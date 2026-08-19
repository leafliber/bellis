import { z } from "zod";

/**
 * 递归 JSON 值 Schema：所有跨 JSON/WS/持久化边界的开放字段（payload、
 * details、arguments、content、intent）的唯一类型。
 *
 * z.unknown() 会接受 bigint、函数、Symbol 等无法 JSON 序列化的值，
 * 导致「通过 Schema 校验的对象在 JSON.stringify 时抛错」。凡是会进入
 * REST、WebSocket 或 SQLite JSON 列的字段都必须使用本 Schema，
 * 保证校验通过 ⇔ 可无损 JSON 序列化。
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/**
 * 可前向扩展的协议对象（phase-1-build-guide.md §6.6「未识别的可选 Payload
 * 字段由 Schema 策略明确处理」的统一答案）。
 *
 * 未知扩展键以 JsonValueSchema 作为 catch-all 校验：扩展值必须是 JSON 值，
 * 因此「通过 Schema 校验 ⇔ 可无损 JSON 序列化」对未知键同样成立。生成的
 * JSON Schema 为 additionalProperties: JsonValueSchema（递归 $ref 定义），
 * Zod / Ajv2020 / AjvDraft7 三方判定一致。
 *
 * 不使用 z.looseObject：其未知键是完全不受约束的 unknown，生成物
 * additionalProperties:{} 无法拒绝 bigint 等非 JSON 值，校验通过的对象
 * 仍可能在 JSON.stringify 时抛错。需要闭合的规范形态对象请用 z.strictObject。
 */
export function extensibleJsonObject<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).catchall(JsonValueSchema);
}
