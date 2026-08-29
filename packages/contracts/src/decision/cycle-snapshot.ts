import { z } from "zod";
import { UuidSchema } from "../common/ids.js";
import { extensibleJsonObject } from "../common/json-value.js";
import { AudienceBatchSchema } from "../signal/audience-batch.js";
import { ToolResultSchema } from "./tool-run.js";

/**
 * Cycle Snapshot：一次模型请求的有界组装输入（phase-3-development-guide.md
 * §7.3 / P0 冻结语义 3、7）。Loop 组装、Runtime 持久化摘要共享本形态。
 *
 * - 后续 Cycle 固定新的水位与 World 版本，不修改已采用的历史快照；
 * - pendingToolResults 只包含上一 Cycle 的 Tool Result（不变量 6：
 *   工具结果只进后续 Cycle），全部为有界 JSON-safe 值；
 * - recentSpeech 是最小热 World Snapshot：最近已采用发言的摘要。
 */
export const RecentUtteranceSchema = extensibleJsonObject({
  schemaVersion: z.literal(1),
  cycleId: UuidSchema,
  text: z.string().min(1).max(2000),
  purpose: z.enum(["answer", "tool_notice", "aside", "reaction"]),
});

export const CycleSnapshotSchema = extensibleJsonObject({
  schemaVersion: z.literal(1),
  turnId: UuidSchema,
  cycleId: UuidSchema,
  /** 0 起；turn 预算内递增。 */
  cycleIndex: z.number().int().nonnegative(),
  maxCyclesPerTurn: z.number().int().positive(),
  /** 本 Cycle 决策依据的弹幕批次（含原始水位范围）。 */
  batch: AudienceBatchSchema,
  /** 上一 Cycle 产生的工具结果（≤8，超限由组装层截断并标记）。 */
  pendingToolResults: z.array(ToolResultSchema).max(8),
  /** 最近已采用发言（最小热 World Snapshot）。 */
  recentSpeech: z.array(RecentUtteranceSchema).max(8),
  /** 本次请求的 Tool Result 截断标记（有 pendingToolResults 时有意义）。 */
  toolResultsTruncated: z.boolean(),
});

export type RecentUtterance = z.infer<typeof RecentUtteranceSchema>;
export type CycleSnapshot = z.infer<typeof CycleSnapshotSchema>;
