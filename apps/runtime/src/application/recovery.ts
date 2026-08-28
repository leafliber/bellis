import {
  ActiveSceneStateSchema,
  Phase1SessionSnapshotSchema,
  Phase2SessionSnapshotSchema,
  formatDecimalString,
} from "@bellis/contracts";
import type {
  ActiveSceneState,
  Phase1SessionSnapshot,
  Phase2SessionSnapshot,
} from "@bellis/contracts";
import type { RecoveryState } from "@bellis/persistence";

/**
 * 恢复与快照构造（docs/phase-1-reference.md；docs/protocols/scene-execution.md §8）。
 *
 * - 重连 Replay Gap：由 P2 `readRecoveryState` 构造快照。
 * - Phase 1 固定限制：`activeScene` 恒为 `null`，`openMediaStreams` 恒为空
 *   （Media Stream 是连接级资源，重连后必须重新注册）。
 * - Phase 2（schemaVersion 2）：携带 `activeScene` 对账视图
 *   （executionState/outcomeCertain/requiresReprepare）；视图由 Scene
 *   Director 的当前状态提供（跨进程重启无 Director 状态时回落 v1 形态，
 *   不虚构执行状态）。
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

/**
 * Phase 2 快照：v1 字段原样 + activeScene 对账视图。
 * activeScene 为 null 时调用方应继续发送 v1 形态（无信息增益）。
 */
export function buildPhase2SessionSnapshot(
  state: RecoveryState,
  options: {
    readonly reason: SnapshotReason;
    readonly sessionStatus: Phase1SessionSnapshot["sessionStatus"];
    readonly runtimeVersion: string;
    readonly generatedAtMs: number;
    readonly activeScene: ActiveSceneState;
  },
): Phase2SessionSnapshot {
  const snapshot: Phase2SessionSnapshot = Phase2SessionSnapshotSchema.parse({
    schemaVersion: 2,
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
    activeScene: ActiveSceneStateSchema.parse(options.activeScene),
    openMediaStreams: [],
    runtimeVersion: options.runtimeVersion,
    generatedAtMs: options.generatedAtMs,
  });
  return snapshot;
}
