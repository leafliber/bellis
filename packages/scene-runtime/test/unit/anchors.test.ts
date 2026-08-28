import { describe, expect, it } from "vitest";
import type { ScenePlan } from "@bellis/contracts";
import {
  isKnownAnchor,
  parseAnchor,
  requiresSpeech,
  resolveAnchorBaseUs,
  resolveCueTargets,
  absoluteTargetUs,
} from "../../src/index.js";

describe("anchor 闭合语法", () => {
  it("合法 anchor 解析", () => {
    expect(parseAnchor("scene_start")).toEqual({ kind: "scene_start" });
    expect(parseAnchor("speech_start")).toEqual({ kind: "speech_start" });
    expect(parseAnchor("speech_end")).toEqual({ kind: "speech_end" });
    expect(parseAnchor("speech.word:0")).toEqual({ kind: "speech_word", wordIndex: 0 });
    expect(parseAnchor("speech.word:42")).toEqual({ kind: "speech_word", wordIndex: 42 });
    expect(parseAnchor("tool_start")).toEqual({ kind: "tool_start" });
    expect(parseAnchor("tool_end")).toEqual({ kind: "tool_end" });
  });

  it("非闭合语法返回 null", () => {
    for (const bad of [
      "",
      "scene",
      "scene-start",
      "speech.word",
      "speech.word:-1",
      "speech.word:1.5",
      "speech.word:",
      "speech.words:1",
      "Speech_Start",
      "speech_start ",
      "anchor/unknown",
    ]) {
      expect(parseAnchor(bad), bad).toBeNull();
      expect(isKnownAnchor(bad), bad).toBe(false);
    }
  });

  it("requiresSpeech 判定", () => {
    expect(requiresSpeech({ kind: "scene_start" })).toBe(false);
    expect(requiresSpeech({ kind: "tool_start" })).toBe(false);
    expect(requiresSpeech({ kind: "tool_end" })).toBe(false);
    expect(requiresSpeech({ kind: "speech_start" })).toBe(true);
    expect(requiresSpeech({ kind: "speech_end" })).toBe(true);
    expect(requiresSpeech({ kind: "speech_word", wordIndex: 3 })).toBe(true);
  });
});

describe("resolveAnchorBaseUs", () => {
  it("scene_start 恒为 0；speech_start 缺省同刻", () => {
    expect(resolveAnchorBaseUs({ kind: "scene_start" }, {})).toBe(0n);
    expect(resolveAnchorBaseUs({ kind: "speech_start" }, {})).toBe(0n);
    expect(resolveAnchorBaseUs({ kind: "speech_start" }, { speechStartOffsetUs: 120_000n })).toBe(
      120_000n,
    );
  });

  it("speech_end / speech.word 未知识别返回 null", () => {
    expect(resolveAnchorBaseUs({ kind: "speech_end" }, {})).toBeNull();
    expect(resolveAnchorBaseUs({ kind: "speech_end" }, { speechDurationUs: 900_000n })).toBe(
      900_000n,
    );
    expect(resolveAnchorBaseUs({ kind: "speech_word", wordIndex: 2 }, {})).toBeNull();
    expect(
      resolveAnchorBaseUs({ kind: "speech_word", wordIndex: 2 }, { wordStartOffsetUs: [0n, 100n] }),
    ).toBeNull();
    expect(
      resolveAnchorBaseUs({ kind: "speech_word", wordIndex: 1 }, { wordStartOffsetUs: [0n, 100n] }),
    ).toBe(100n);
  });
});

describe("resolveCueTargets（纯函数）", () => {
  const plan: ScenePlan = {
    schemaVersion: 1,
    scene: {
      schemaVersion: 1,
      sceneId: "44444444-4444-4444-8444-444444444444",
      cycleId: "33333333-3333-4333-8333-333333333333",
      groups: [
        {
          schemaVersion: 1,
          groupId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          lanes: ["audio", "subtitle", "avatar"],
          level: "hard",
        },
      ],
      deadlineMs: 500,
      interruptPolicy: "fade",
    },
    cues: [
      {
        schemaVersion: 1,
        cueId: "55555555-5555-4555-8555-555555555555",
        lane: "audio",
        anchor: "scene_start",
        offsetMs: 0,
        intent: {},
      },
      {
        schemaVersion: 1,
        cueId: "55555555-5555-4555-8555-555555555556",
        lane: "subtitle",
        anchor: "scene_start",
        offsetMs: 50,
        intent: {},
      },
      {
        schemaVersion: 1,
        cueId: "55555555-5555-4555-8555-555555555557",
        lane: "avatar",
        anchor: "speech.word:1",
        offsetMs: -20,
        intent: {},
      },
    ],
  };

  it("T0 + offsetMs；未知 anchor 的 Cue 为 pending（null）", () => {
    const targets = resolveCueTargets(plan);
    expect(targets[0]?.targetOffsetUs).toBe(0n);
    expect(targets[1]?.targetOffsetUs).toBe(50_000n);
    expect(targets[2]?.targetOffsetUs).toBeNull();
    expect(absoluteTargetUs(targets[0]!, 1_000_000n)).toBe(1_000_000n);
    expect(absoluteTargetUs(targets[2]!, 1_000_000n)).toBeNull();

    const withWords = resolveCueTargets(plan, { wordStartOffsetUs: [0n, 80_000n] });
    expect(withWords[2]?.targetOffsetUs).toBe(60_000n); // 80ms - 20ms
  });
});
