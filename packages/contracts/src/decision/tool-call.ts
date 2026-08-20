import { z } from "zod";
import { UuidSchema } from "../common/ids.js";
import {
  JsonValueSchema,
  extensibleJsonRecord,
  extensibleJsonObject,
} from "../common/json-value.js";

/**
 * ToolCall：模型发起的一次工具调用。
 * 高风险/不可幂等工具必须携带 idempotencyKey，重试不得产生重复副作用
 * （architecture-plan.md §18）。arguments 的键与值必须是 JSON 值，
 * "__proto__" 等危险键名同样无损保留（extensibleJsonRecord）。
 */
export const ToolCallSchema = extensibleJsonObject({
  schemaVersion: z.literal(1),
  toolRunId: UuidSchema,
  toolName: z.string().min(1).max(128),
  arguments: extensibleJsonRecord(JsonValueSchema),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

export type ToolCall = z.infer<typeof ToolCallSchema>;
