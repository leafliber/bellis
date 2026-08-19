import { z } from "zod";
import { UuidSchema } from "../common/ids.js";

/**
 * ToolCall：模型发起的一次工具调用。
 * 高风险/不可幂等工具必须携带 idempotencyKey，重试不得产生重复副作用
 * （architecture-plan.md §18）。
 */
export const ToolCallSchema = z.object({
  schemaVersion: z.literal(1),
  toolRunId: UuidSchema,
  toolName: z.string().min(1).max(128),
  arguments: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

export type ToolCall = z.infer<typeof ToolCallSchema>;
