import { z } from "zod";
import { UuidSchema } from "../common/ids.js";
import { extensibleJsonObject } from "../common/json-value.js";
import { CueLaneSchema } from "./cue.js";

/**
 * 同步等级（architecture-plan.md §9.3）：
 * hard 整组等待或整体降级；soft 超时可缺席或晚到；detached 不影响 Scene。
 */
export const SyncLevelSchema = z.enum(["hard", "soft", "detached"]);

export const SyncGroupSchema = extensibleJsonObject({
  schemaVersion: z.literal(1),
  groupId: UuidSchema,
  lanes: z.array(CueLaneSchema).min(1).max(8),
  level: SyncLevelSchema,
});

/**
 * Scene：ActionFrame 经校验和编译后的可执行计划。
 * Scene 真正执行的单调时间（commitAtRuntimeUs）只存在于当前 Runtime 的
 * Timeline 时钟域，不进入本 Schema，也不写入 state.db。
 * 字段命名为 sceneId/cueId（与 Phase 1 session.snapshot 一致，
 * 见 architecture-plan.md §9.1 的冻结形态说明）。
 */
export const SceneSchema = extensibleJsonObject({
  schemaVersion: z.literal(1),
  sceneId: UuidSchema,
  cycleId: UuidSchema,
  groups: z.array(SyncGroupSchema).min(1).max(16),
  /** Prepare/Commit 允许的最大等待时长（毫秒）。 */
  deadlineMs: z.number().int().nonnegative(),
  interruptPolicy: z.enum(["finish", "fade", "immediate"]),
});

export type SyncLevel = z.infer<typeof SyncLevelSchema>;
export type SyncGroup = z.infer<typeof SyncGroupSchema>;
export type Scene = z.infer<typeof SceneSchema>;
