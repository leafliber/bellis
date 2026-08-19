import { z } from "zod";
import { DecimalStringSchema } from "../common/decimal-string.js";
import { UuidSchema } from "../common/ids.js";

/**
 * Phase 1 的 session.snapshot 固定形态（phase-1-build-guide.md §8.2）。
 *
 * - Phase 1 不执行真实 Scene，activeScene 恒为 null。
 * - Media Stream 是连接级资源，重连后必须重新打开，Snapshot 不声称恢复旧 Stream。
 * - Outbox 是 Runtime 内部状态，不暴露给普通客户端。
 * - 后续阶段扩展只能新增版本化可选字段或提升 schemaVersion。
 */
export const Phase1SessionSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  reason: z.enum(["initial", "replay_gap", "requested"]),
  sessionId: UuidSchema,
  sessionStatus: z.enum(["starting", "ready", "draining"]),
  latestServerSeq: DecimalStringSchema,
  signalWatermarks: z.array(
    z.object({
      source: z.string().min(1).max(64),
      watermark: DecimalStringSchema,
    }),
  ),
  lastCommittedScene: z
    .object({
      sceneId: UuidSchema,
      cycleId: UuidSchema,
      status: z.literal("committed"),
      committedAtMs: z.number().int().nonnegative(),
    })
    .optional(),
  activeScene: z.null(),
  openMediaStreams: z.array(z.unknown()).max(0),
  runtimeVersion: z.string().min(1).max(64),
  generatedAtMs: z.number().int().nonnegative(),
});

export type Phase1SessionSnapshot = z.infer<typeof Phase1SessionSnapshotSchema>;
