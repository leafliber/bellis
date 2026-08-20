import { z } from "zod";
import { UuidSchema } from "../common/ids.js";
import { JsonValueSchema, extensibleJsonObject } from "../common/json-value.js";

/**
 * Signal：尚未被决策消费的输入事实（architecture-plan.md §5）。
 * kind/source 为插件自定义标识；payload 必须是 JSON 值，扩展字段
 * 以未知键形式透传（loose，配合 §6.6 的前向兼容策略）。
 */
export const SignalSchema = extensibleJsonObject({
  schemaVersion: z.literal(1),
  id: UuidSchema,
  kind: z.string().min(1).max(64),
  source: z.string().min(1).max(64),
  /** 墙上事实时间：Unix epoch milliseconds，仅用于事件发生时间、审计和展示。 */
  occurredAt: z.number().int().nonnegative(),
  priority: z.number().int().min(0).max(1000),
  payload: JsonValueSchema,
});

export type Signal = z.infer<typeof SignalSchema>;
