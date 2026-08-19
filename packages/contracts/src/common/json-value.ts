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
