import { describe, expect, it } from "vitest";
import { Phase1SessionSnapshotSchema } from "@bellis/contracts";
import { buildSessionSnapshot } from "../../src/index.js";

describe("buildSessionSnapshot", () => {
  const state = {
    sessionId: "11111111-1111-4111-8111-111111111111",
    latestServerSeq: 9007199254740993n,
    signalWatermarks: [
      { source: "asr", watermark: 42n },
      { source: "vision", watermark: 99n },
    ],
    lastCommittedScene: {
      sceneId: "22222222-2222-4222-8222-222222222222",
      cycleId: "33333333-3333-4333-8333-333333333333",
      committedAtMs: 1755648000123,
    },
  };

  it("构造合法 Phase1SessionSnapshot（big → 十进制字符串）", () => {
    const snapshot = buildSessionSnapshot(state, {
      reason: "replay_gap",
      sessionStatus: "ready",
      runtimeVersion: "0.1.0-test",
      generatedAtMs: 1,
    });
    expect(snapshot.latestServerSeq).toBe("9007199254740993");
    expect(snapshot.signalWatermarks).toEqual([
      { source: "asr", watermark: "42" },
      { source: "vision", watermark: "99" },
    ]);
    expect(snapshot.activeScene).toBeNull();
    expect(snapshot.openMediaStreams).toEqual([]);
    expect(Phase1SessionSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("无提交 Scene 时 lastCommittedScene 缺席", () => {
    const snapshot = buildSessionSnapshot(
      { ...state, lastCommittedScene: null },
      { reason: "initial", sessionStatus: "ready", runtimeVersion: "v", generatedAtMs: 1 },
    );
    expect(snapshot.lastCommittedScene).toBeUndefined();
  });

  it("上游字段漂移被 Schema 拒绝（防线上脏快照）", () => {
    expect(() =>
      buildSessionSnapshot(
        { ...state, sessionId: "not-a-uuid" },
        { reason: "requested", sessionStatus: "ready", runtimeVersion: "v", generatedAtMs: 1 },
      ),
    ).toThrow();
  });
});
