import { z } from "zod";
import { UuidSchema } from "../common/ids.js";
import { ActionFrameSchema } from "./action-frame.js";
import { ToolCallSchema } from "./tool-call.js";

/**
 * DecisionPacket：一次模型请求的完整规范形态（ADR 0001）。
 *
 * - 恰好包含一个 ActionFrame；发言只存在于 action.speech。
 * - 不保留顶层 message 或 speech 字段。
 * - Model Provider 原始输出可以不同，但进入核心前必须规范化为该形态。
 */
export const DecisionPacketSchema = z.object({
  schemaVersion: z.literal(1),
  cycleId: UuidSchema,
  toolCalls: z.array(ToolCallSchema).max(8),
  action: ActionFrameSchema,
  next: z.enum(["finish", "after_tools", "continue"]),
});

export type DecisionPacket = z.infer<typeof DecisionPacketSchema>;
