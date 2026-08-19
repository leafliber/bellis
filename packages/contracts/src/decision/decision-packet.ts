import { z } from "zod";
import { UuidSchema } from "../common/ids.js";
import { ActionFrameSchema } from "./action-frame.js";
import { ToolCallSchema } from "./tool-call.js";

/**
 * DecisionPacket：一次模型请求的完整规范形态（ADR 0001）。
 *
 * - 恰好包含一个 ActionFrame；发言只存在于 action.speech。
 * - 顶层是 strictObject 闭合形态：ADR 0001 否决的遗留顶层 message/speech
 *   连同一切未知顶层字段都被结构性拒绝——Schema 层不存在第二个发言字段，
 *   不依赖下游「约定不读取」。规范形态的演进通过提升 schemaVersion 进行；
 *   决策包由 Model Adapter 在同进程内规范化，不存在跨部署的版本偏斜，
 *   闭合不产生 §6.6 意义上的兼容代价。
 * - Model Provider 原始输出可以不同，但进入核心前必须规范化并通过本
 *   Schema 校验；Provider 私有字段在规范化时丢弃或收纳进 action 内的
 *   扩展对象，不在顶层存活。
 */
export const DecisionPacketSchema = z.strictObject({
  schemaVersion: z.literal(1),
  cycleId: UuidSchema,
  toolCalls: z.array(ToolCallSchema).max(8),
  action: ActionFrameSchema,
  next: z.enum(["finish", "after_tools", "continue"]),
});

export type DecisionPacket = z.infer<typeof DecisionPacketSchema>;
