import { z } from "zod";
import { UuidSchema } from "../common/ids.js";

/**
 * Signal：尚未被决策消费的输入事实（architecture-plan.md §5）。
 * kind/source 为插件自定义标识；payload 在 Phase 1 不做业务约束。
 */
export const SignalSchema = z.object({
  schemaVersion: z.literal(1),
  id: UuidSchema,
  kind: z.string().min(1).max(64),
  source: z.string().min(1).max(64),
  /** 墙上事实时间：Unix epoch milliseconds，仅用于事件发生时间、审计和展示。 */
  occurredAt: z.number().int().nonnegative(),
  priority: z.number().int().min(0).max(1000),
  payload: z.unknown(),
});

export type Signal = z.infer<typeof SignalSchema>;
