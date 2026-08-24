import { z } from "zod";
import { DecimalStringSchema } from "../common/decimal-string.js";
import { UuidSchema } from "../common/ids.js";
import { extensibleJsonObject } from "../common/json-value.js";
import { SceneExecutionStateSchema } from "../scene/scene-plan.js";

/**
 * Phase 1 的 session.snapshot 固定形态（docs/phase-1-reference.md）。
 *
 * - Phase 1 不执行真实 Scene，activeScene 恒为 null。
 * - Media Stream 是连接级资源，重连后必须重新打开，Snapshot 不声称恢复旧 Stream。
 * - Outbox 是 Runtime 内部状态，不暴露给普通客户端。
 * - 后续阶段扩展只能新增版本化可选字段或提升 schemaVersion；
 *   extensibleJsonObject 允许 JSON 值的未知扩展键透传，配合该兼容策略。
 */
export const Phase1SessionSnapshotSchema = extensibleJsonObject({
  schemaVersion: z.literal(1),
  reason: z.enum(["initial", "replay_gap", "requested"]),
  sessionId: UuidSchema,
  sessionStatus: z.enum(["starting", "ready", "draining"]),
  latestServerSeq: DecimalStringSchema,
  signalWatermarks: z.array(
    extensibleJsonObject({
      source: z.string().min(1).max(64),
      watermark: DecimalStringSchema,
    }),
  ),
  lastCommittedScene: extensibleJsonObject({
    sceneId: UuidSchema,
    cycleId: UuidSchema,
    status: z.literal("committed"),
    committedAtMs: z.number().int().nonnegative(),
  }).optional(),
  activeScene: z.null(),
  openMediaStreams: z.array(z.unknown()).max(0),
  runtimeVersion: z.string().min(1).max(64),
  generatedAtMs: z.number().int().nonnegative(),
});

export type Phase1SessionSnapshot = z.infer<typeof Phase1SessionSnapshotSchema>;

/**
 * Phase 2 快照中的活动 Scene 对账视图（docs/phase-2-development-guide.md §5.5）。
 *
 * - executionState：跨 Runtime/Stage 的公开执行状态（SceneExecutionState）。
 * - outcomeCertain：false 表示执行结果无法证明（uncertain 语义），恢复
 *   对账后不得自动重播外部效果，只能保持 uncertain 或转入终态。
 * - requiresReprepare：true 表示 Stage 侧准备资源已随连接丢失
 *   （重连清空未 Commit 的准备缓存），新调度前必须重新 Prepare。
 */
export const ActiveSceneStateSchema = extensibleJsonObject({
  sceneId: UuidSchema,
  cycleId: UuidSchema,
  executionState: SceneExecutionStateSchema,
  outcomeCertain: z.boolean(),
  requiresReprepare: z.boolean(),
});

export type ActiveSceneState = z.infer<typeof ActiveSceneStateSchema>;

/**
 * Phase 2 的 session.snapshot 版本化形态（docs/phase-2-development-guide.md §5.5）。
 *
 * - schemaVersion 提升为 2：与 Phase 1 快照（schemaVersion 1）通过
 *   SessionSnapshotUnionSchema 判别区分；Phase 1 语义原样保留。
 * - activeScene 承载活动 Scene 的逻辑状态、结果确定性与是否需要重新
 *   Prepare；无活动 Scene 时为 null。
 * - openMediaStreams 仍恒为空：Media Stream 是连接级资源，重连后必须
 *   重新声明（media.stream.announce），Snapshot 不声称恢复旧 Stream。
 * - 单调 Commit 时间（commitAtRuntimeUs）不持久化，不进入 Snapshot。
 */
export const Phase2SessionSnapshotSchema = extensibleJsonObject({
  schemaVersion: z.literal(2),
  reason: z.enum(["initial", "replay_gap", "requested"]),
  sessionId: UuidSchema,
  sessionStatus: z.enum(["starting", "ready", "draining"]),
  latestServerSeq: DecimalStringSchema,
  signalWatermarks: z.array(
    extensibleJsonObject({
      source: z.string().min(1).max(64),
      watermark: DecimalStringSchema,
    }),
  ),
  lastCommittedScene: extensibleJsonObject({
    sceneId: UuidSchema,
    cycleId: UuidSchema,
    status: z.literal("committed"),
    committedAtMs: z.number().int().nonnegative(),
  }).optional(),
  activeScene: ActiveSceneStateSchema.nullable(),
  openMediaStreams: z.array(z.unknown()).max(0),
  runtimeVersion: z.string().min(1).max(64),
  generatedAtMs: z.number().int().nonnegative(),
});

export type Phase2SessionSnapshot = z.infer<typeof Phase2SessionSnapshotSchema>;

/**
 * 版本化 Snapshot 联合入口：session.snapshot 消息承载的快照对象
 * 必须是 Phase 1（schemaVersion 1）或 Phase 2（schemaVersion 2）形态之一。
 *
 * 消费端按 schemaVersion 判别：读取到未知版本必须返回明确兼容错误，
 * 不得把未验证字段当作已知语义。Runtime 在未启用 Phase 2 演出链路的
 * 会话中继续发送 Phase 1 形态，Phase 1 客户端行为不变。
 */
export const SessionSnapshotUnionSchema = z.union([
  Phase1SessionSnapshotSchema,
  Phase2SessionSnapshotSchema,
]);

export type SessionSnapshot = z.infer<typeof SessionSnapshotUnionSchema>;
