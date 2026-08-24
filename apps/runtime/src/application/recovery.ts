import { Phase1SessionSnapshotSchema, formatDecimalString } from "@bellis/contracts";
import type { Phase1SessionSnapshot } from "@bellis/contracts";
import type { RecoveryState } from "@bellis/persistence";

/**
 * 恢复与快照构造（docs/phase-1-reference.md）。
 *
 * - 重连 Replay Gap：由 P2 `readRecoveryState` 构造 `Phase1SessionSnapshot`。
 * - Phase 1 固定限制：`activeScene` 恒为 `null`，`openMediaStreams` 恒为空
 *   （Media Stream 是连接级资源，重连后必须重新注册）。
 * - 构造后经 Schema 再校验一次，防止上游字段漂移直接上线。
 */

export type SnapshotReason = Phase1SessionSnapshot["reason"];

export function buildSessionSnapshot(
  state: RecoveryState,
  options: {
    reason: SnapshotReason;
    sessionStatus: Phase1SessionSnapshot["sessionStatus"];
    runtimeVersion: string;
    generatedAtMs: number;
  },
): Phase1SessionSnapshot {
  const snapshot: Phase1SessionSnapshot = Phase1SessionSnapshotSchema.parse({
    schemaVersion: 1,
    reason: options.reason,
    sessionId: state.sessionId,
    sessionStatus: options.sessionStatus,
    latestServerSeq: formatDecimalString(state.latestServerSeq),
    signalWatermarks: state.signalWatermarks.map((entry) => ({
      source: entry.source,
      watermark: formatDecimalString(entry.watermark),
    })),
    ...(state.lastCommittedScene === null
      ? {}
      : {
          lastCommittedScene: {
            sceneId: state.lastCommittedScene.sceneId,
            cycleId: state.lastCommittedScene.cycleId,
            status: "committed",
            committedAtMs: state.lastCommittedScene.committedAtMs,
          },
        }),
    activeScene: null,
    openMediaStreams: [],
    runtimeVersion: options.runtimeVersion,
    generatedAtMs: options.generatedAtMs,
  });
  return snapshot;
}
