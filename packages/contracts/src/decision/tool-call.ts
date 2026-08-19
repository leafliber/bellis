import { z } from "zod";
import { UuidSchema } from "../common/ids.js";
import { JsonValueSchema, extensibleJsonObject } from "../common/json-value.js";

/**
 * ToolCall：模型发起的一次工具调用。
 * 高风险/不可幂等工具必须携带 idempotencyKey，重试不得产生重复副作用
 * （architecture-plan.md §18）。arguments 的值必须是 JSON 值。
 */
export const ToolCallSchema = extensibleJsonObject({
  schemaVersion: z.literal(1),
  toolRunId: UuidSchema,
  toolName: z.string().min(1).max(128),
  arguments: z.record(z.string(), JsonValueSchema),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

export type ToolCall = z.infer<typeof ToolCallSchema>;
