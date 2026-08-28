import { describe, expect, it } from "vitest";
import type {
  ActionFrame,
  AvatarIntent,
  SpeechIntent,
  StageCapabilities,
  SyncPolicy,
} from "@bellis/contracts";
import { PHASE_2_PCM_CONTENT_TYPE } from "@bellis/contracts";
import { compileActionFrame, type CompileIdSource, type CompileResult } from "../../src/index.js";

/** 固定序列 ID 源：相同构造顺序 ⇒ 相同 ID（确定性编译的输入侧）。 */
class FixedIdSource implements CompileIdSource {
  #next = 0;
  nextId(): string {
    const id = this.#next;
    this.#next += 1;
    return `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
  }
}

export const CAPABILITIES: StageCapabilities = {
  schemaVersion: 1,
  audio: { contentTypes: [PHASE_2_PCM_CONTENT_TYPE], maxBufferedUs: "2000000" },
  subtitle: { supported: true },
  avatar: {
    adapter: "fake-recording",
    motions: ["nod_agree", "wave"],
    expressions: ["happy"],
  },
};

const SPEECH: SpeechIntent = {
  schemaVersion: 1,
  text: "我看看现在的任务进度",
  purpose: "tool_notice",
  interruptible: true,
};

const AVATAR_INTENT: AvatarIntent = {
  schemaVersion: 1,
  intentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  motion: "nod_agree",
  channels: ["head", "body"],
  priority: 80,
  durationMs: 1200,
  interruptible: true,
  exclusive: false,
  mutexTags: [],
};

const SYNC: SyncPolicy = {
  schemaVersion: 1,
  hardLanes: ["audio", "subtitle", "avatar"],
  softTimeoutMs: 50,
};

function compile(
  frame: ActionFrame,
  capabilities: StageCapabilities = CAPABILITIES,
  policy?: Parameters<typeof compileActionFrame>[0]["policy"],
): CompileResult {
  return compileActionFrame({
    frame,
    cycleId: "33333333-3333-4333-8333-333333333333",
    capabilities,
    ids: new FixedIdSource(),
    ...(policy === undefined ? {} : { policy }),
  });
}

describe("compileActionFrame 黄金测试", () => {
  it("noOp 帧不伪造空 Scene", () => {
    expect(
      compile({ schemaVersion: 1, sync: { schemaVersion: 1, hardLanes: [] }, noOp: true }),
    ).toEqual({
      kind: "noop",
    });
  });

  it("speech 生成 audio+subtitle Cue，引用同一 SpeechIntent（单一发言来源）", () => {
    const result = compile({ schemaVersion: 1, speech: SPEECH, sync: SYNC });
    expect(result.kind).toBe("scene");
    if (result.kind !== "scene") {
      return;
    }
    expect(result.plan.cues.map((cue) => cue.lane)).toEqual(["audio", "subtitle"]);
    expect(
      result.plan.cues.every(
        (cue) =>
          typeof cue.intent === "object" &&
          cue.intent !== null &&
          "speechRef" in cue.intent &&
          cue.intent.speechRef === "plan",
      ),
    ).toBe(true);
    // speech 单份存放于 plan 级扩展键，Cue 不复制全文。
    const planRecord = result.plan as Record<string, unknown>;
    expect(planRecord.speech).toEqual(SPEECH);
    expect(JSON.stringify(result.plan.cues)).not.toContain(SPEECH.text);
    // hard 组：audio+subtitle（avatar 无 Cue 不进组）。
    expect(result.plan.scene.groups).toHaveLength(1);
    expect(result.plan.scene.groups[0]?.level).toBe("hard");
    expect(result.plan.scene.groups[0]?.lanes).toEqual(["audio", "subtitle"]);
    expect(result.plan.scene.cycleId).toBe("33333333-3333-4333-8333-333333333333");
    expect(result.plan.scene.interruptPolicy).toBe("fade");
  });

  it("speech + avatar：audio/subtitle hard 组 + avatar cue 锚定 speech_start", () => {
    const result = compile({
      schemaVersion: 1,
      speech: SPEECH,
      avatar: [AVATAR_INTENT],
      sync: SYNC,
    });
    expect(result.kind).toBe("scene");
    if (result.kind !== "scene") {
      return;
    }
    expect(result.plan.cues.map((cue) => cue.lane)).toEqual(["audio", "subtitle", "avatar"]);
    const avatarCue = result.plan.cues.find((cue) => cue.lane === "avatar");
    expect(avatarCue?.anchor).toBe("speech_start");
    // durationMs 随意图透传：Stage Avatar Lane 的呈现窗口（真实完成信号）。
    expect(avatarCue?.intent).toEqual({
      intentId: AVATAR_INTENT.intentId,
      motion: "nod_agree",
      durationMs: AVATAR_INTENT.durationMs,
    });
    expect(result.plan.scene.groups).toHaveLength(1);
    expect(result.plan.scene.groups[0]?.lanes).toEqual(["audio", "subtitle", "avatar"]);
  });

  it("avatar-only 帧（静默行动）：soft 组，锚定 scene_start，无 speech 扩展键", () => {
    const result = compile({
      schemaVersion: 1,
      avatar: [AVATAR_INTENT],
      sync: { schemaVersion: 1, hardLanes: [] },
    });
    expect(result.kind).toBe("scene");
    if (result.kind !== "scene") {
      return;
    }
    expect(result.plan.cues.map((cue) => cue.lane)).toEqual(["avatar"]);
    expect(result.plan.cues[0]?.anchor).toBe("scene_start");
    expect(result.plan.scene.groups[0]?.level).toBe("soft");
    expect((result.plan as Record<string, unknown>).speech).toBeUndefined();
  });

  it("有 speech 时 avatar cue 锚定 speech_start", () => {
    const result = compile({
      schemaVersion: 1,
      speech: SPEECH,
      avatar: [AVATAR_INTENT],
      sync: { schemaVersion: 1, hardLanes: [] },
    });
    expect(result.kind).toBe("scene");
    if (result.kind === "scene") {
      expect(result.plan.cues.find((cue) => cue.lane === "avatar")?.anchor).toBe("speech_start");
    }
  });

  it("不可打断意图 → interruptPolicy=finish", () => {
    const result = compile({
      schemaVersion: 1,
      avatar: [{ ...AVATAR_INTENT, interruptible: false }],
      sync: { schemaVersion: 1, hardLanes: [] },
    });
    expect(result.kind).toBe("scene");
    if (result.kind === "scene") {
      expect(result.plan.scene.interruptPolicy).toBe("finish");
    }
  });

  it("hard lane 缺能力（字幕不支持）→ 拒绝 hard_lane_unsatisfiable", () => {
    const caps: StageCapabilities = {
      ...CAPABILITIES,
      subtitle: { supported: false },
    };
    const result = compile({ schemaVersion: 1, speech: SPEECH, sync: SYNC }, caps);
    expect(result).toMatchObject({
      kind: "rejected",
      issues: [
        {
          code: "hard_lane_unsatisfiable",
          lane: "subtitle",
        },
      ],
    });
  });

  it("非 hard lane 缺能力：默认拒绝，policy omit 降级为 advisory", () => {
    const frame: ActionFrame = {
      schemaVersion: 1,
      avatar: [AVATAR_INTENT],
      sync: { schemaVersion: 1, hardLanes: ["audio"] },
    };
    const caps: StageCapabilities = {
      ...CAPABILITIES,
      avatar: { ...CAPABILITIES.avatar, motions: [] },
    };
    const rejected = compile(frame, caps);
    expect(rejected.kind).toBe("rejected");

    const omitted = compile(frame, caps, { missingCapability: "omit" });
    expect(omitted.kind).toBe("rejected"); // 全部 Cue 被 omit → 无可执行内容
    const mixed = compile(
      {
        schemaVersion: 1,
        speech: SPEECH,
        avatar: [AVATAR_INTENT],
        // avatar 不在 hardLanes：缺能力时 policy omit 可以丢弃。
        sync: { schemaVersion: 1, hardLanes: ["audio", "subtitle"] },
      },
      caps,
      { missingCapability: "omit" },
    );
    expect(mixed.kind).toBe("scene");
    if (mixed.kind === "scene") {
      expect(mixed.plan.cues.map((cue) => cue.lane)).toEqual(["audio", "subtitle"]);
      expect(mixed.plan.scene.groups[0]?.lanes).not.toContain("avatar");
      expect(mixed.advisories.some((issue) => issue.lane === "avatar")).toBe(true);
    }
  });

  it("未声明的 motion → capability_missing（拒绝或 advisory）", () => {
    const result = compile({
      schemaVersion: 1,
      speech: SPEECH,
      avatar: [{ ...AVATAR_INTENT, motion: "backflip" }],
      sync: { schemaVersion: 1, hardLanes: [] },
    });
    expect(result).toMatchObject({
      kind: "rejected",
      issues: [{ code: "capability_missing", lane: "avatar" }],
    });
  });

  it("game/overlay 意图在 Stage 能力模型下按缺能力处理", () => {
    const result = compile({
      schemaVersion: 1,
      overlay: [
        { schemaVersion: 1, intentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", kind: "status" },
      ],
      sync: { schemaVersion: 1, hardLanes: [] },
    });
    expect(result).toMatchObject({
      kind: "rejected",
      issues: [{ code: "capability_missing", lane: "overlay" }],
    });
  });

  it("Cue 超上限 → cue_limit_exceeded", () => {
    const manyAvatars = Array.from({ length: 3 }, (_v, index) => ({
      ...AVATAR_INTENT,
      intentId: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${index}`,
    }));
    const withSpeech: ActionFrame = {
      schemaVersion: 1,
      speech: SPEECH,
      avatar: manyAvatars,
      sync: { schemaVersion: 1, hardLanes: ["audio", "subtitle"] },
    };
    const result = compile(withSpeech, CAPABILITIES, { maxCues: 3 });
    expect(result).toMatchObject({ kind: "rejected", issues: [{ code: "cue_limit_exceeded" }] });
  });
});

describe("compileActionFrame 输出复核", () => {
  it("编译结果通过 ScenePlanSchema 与结构校验（运行期，不靠静态类型）", () => {
    const result = compile({
      schemaVersion: 1,
      speech: SPEECH,
      avatar: [AVATAR_INTENT],
      sync: SYNC,
    });
    expect(result.kind).toBe("scene");
    if (result.kind !== "scene") {
      return;
    }
    expect(() => JSON.parse(JSON.stringify(result.plan))).not.toThrow();
  });
});
