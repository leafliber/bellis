import { z } from "zod";
import { extensibleJsonObject } from "../common/json-value.js";
import { CueSchema } from "./cue.js";
import { SceneSchema } from "./scene.js";

/**
 * Scene 执行状态（Phase 2，docs/phase-2-development-guide.md §5.2）。
 *
 * 这是跨 Runtime/Stage 的公开执行状态，不是 Scene Director 内部状态机全集：
 * Director 内部的 created/committing/cancelling 等过渡态不进入 Wire，
 * 只在持久化生命周期 Record 中记录（P4）。
 *
 * - preparing/ready/scheduled/running：活动中的确定状态；
 * - completed/cancelled/failed：终态，迟到回执不得复活；
 * - uncertain：进程或 Stage 失联且执行结果无法证明；恢复对账后只能保持
 *   uncertain 或转入终态，绝不自动重播外部效果。
 */
export const SceneExecutionStateSchema = z.enum([
  "preparing",
  "ready",
  "scheduled",
  "running",
  "completed",
  "cancelled",
  "failed",
  "uncertain",
]);

/**
 * ScenePlan：Action Compiler 的完整编译结果，跨 Runtime/Stage 校验、
 * 传输与持久化的最小聚合（Phase 2 Contracts Gate 缺口 1）。
 *
 * - scene 与 cues 分开冻结（SceneSchema/CueSchema，Phase 1）；ScenePlan
 *   把两者组合为可整体校验的版本化聚合，不改变任何一方语义。
 * - cues 数量上限与 scene.prepared 通知一致（64）；超出属于编译拒绝，
 *   不是 Wire 兼容问题。
 * - cueId 在 plan 内唯一、anchor 引用闭合等约束由 Action Compiler 在
 *   编译期保证（确定性拒绝），Schema 只承载结构校验。
 */
export const ScenePlanSchema = extensibleJsonObject({
  schemaVersion: z.literal(1),
  scene: SceneSchema,
  cues: z.array(CueSchema).min(1).max(64),
  /** soft Lane 准备预算；缺省由 Stage 按 500ms 处理。 */
  softTimeoutMs: z.number().int().min(0).max(60_000).optional(),
});

export type SceneExecutionState = z.infer<typeof SceneExecutionStateSchema>;
export type ScenePlan = z.infer<typeof ScenePlanSchema>;
