import { describe, expect, it } from "vitest";
import type { Cue } from "@bellis/contracts";
import {
  AudioLaneAdapter,
  type AudioEnvironment,
  type WorkletMessage,
} from "../../src/lanes/audio/audio-lane.js";
import {
  SubtitleLaneAdapter,
  type SubtitleDocument,
  type SubtitleLine,
} from "../../src/lanes/subtitle/subtitle-lane.js";
import { RecordingAvatarAdapter } from "../../src/lanes/avatar/avatar-lane.js";

/** 三条演出 Lane 的 Port 协议测试（Fake 环境，无浏览器 API）。 */

class FakeAudioEnvironment implements AudioEnvironment {
  armed = false;
  armShouldFail = false;
  nodeReady = false;
  readonly messages: WorkletMessage[] = [];
  #handler: ((message: WorkletMessage) => void) | null = null;

  async arm(): Promise<boolean> {
    if (this.armShouldFail) {
      return false;
    }
    this.armed = true;
    return true;
  }

  async ensureNode(): Promise<void> {
    if (!this.armed) {
      throw new Error("not_armed");
    }
    this.nodeReady = true;
  }

  postToWorklet(message: WorkletMessage): void {
    this.messages.push(message);
  }

  onWorkletMessage(handler: ((message: WorkletMessage) => void) | null): void {
    this.#handler = handler;
  }

  /** 测试驱动：模拟 Worklet 上报。 */
  reportStats(underruns: number): void {
    this.#handler?.({ v: 1, op: "stats", underruns });
  }

  async close(): Promise<void> {
    this.nodeReady = false;
  }
}

const AUDIO_CUES: readonly Cue[] = [
  {
    schemaVersion: 1,
    cueId: "55555555-5555-4555-8555-555555555555",
    lane: "audio",
    anchor: "scene_start",
    offsetMs: 0,
    intent: {},
  },
];

describe("AudioLaneAdapter", () => {
  it("未 Arm：prepare 返回 audio_not_armed，绝不虚报 Ready", async () => {
    const env = new FakeAudioEnvironment();
    const lane = new AudioLaneAdapter({ environment: env });
    const result = await lane.prepare("s1", AUDIO_CUES, new AbortController().signal);
    expect(result).toEqual({ ready: false, reason: "audio_not_armed" });
  });

  it("Arm 后 prepare 等待预缓冲达标；帧先行到达则立即 ready", async () => {
    const env = new FakeAudioEnvironment();
    const lane = new AudioLaneAdapter({ environment: env, minPreparedFrames: 3 });
    await lane.arm();
    const preparing = lane.prepare("s1", AUDIO_CUES, new AbortController().signal);
    let settled = false;
    void preparing.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false); // 帧不足：等待
    lane.appendFrame("s1", new Int16Array(960));
    lane.appendFrame("s1", new Int16Array(960));
    await Promise.resolve();
    expect(settled).toBe(false);
    lane.appendFrame("s1", new Int16Array(960)); // 第 3 帧：达标
    const result = await preparing;
    expect(result).toEqual({ ready: true });
    // 帧（缓冲）在 start 前不生效：无 switch 消息。
    expect(env.messages.filter((m) => m.op === "switch")).toHaveLength(0);
    await lane.start("s1", 0n, AUDIO_CUES);
    expect(env.messages.at(-1)).toMatchObject({ op: "switch", sceneId: "s1" });
    env.reportStats(2);
    expect(lane.underruns).toBe(2);
    await lane.close();
  });

  it("取消只发目标 Scene 的 cancel；clearAll 清空全部", async () => {
    const env = new FakeAudioEnvironment();
    const lane = new AudioLaneAdapter({ environment: env, minPreparedFrames: 1 });
    await lane.arm();
    lane.appendFrame("s1", new Int16Array(960)); // 帧先行：prepare 立即达标
    await lane.prepare("s1", AUDIO_CUES, new AbortController().signal);
    await lane.stop("s1", "urgent_interrupt");
    expect(env.messages).toContainEqual({ v: 1, op: "cancel", sceneId: "s1" });
    lane.clearAll();
    expect(env.messages.at(-1)?.op).toBe("clear");
    await lane.close();
  });
});

class FakeLine implements SubtitleLine {
  text: string | null = null;
  visible = false;
  removed = false;
  setText(text: string): void {
    this.text = text;
  }
  setVisible(visible: boolean): void {
    this.visible = visible;
  }
  remove(): void {
    this.removed = true;
  }
}

class FakeSubtitleDocument implements SubtitleDocument {
  readonly lines: FakeLine[] = [];
  createLine(): SubtitleLine {
    const line = new FakeLine();
    this.lines.push(line);
    return line;
  }
}

describe("SubtitleLaneAdapter", () => {
  it("prepare 只创建不可见行；start 显示；stop 撤下并移除；文本经文本节点", async () => {
    const doc = new FakeSubtitleDocument();
    const lane = new SubtitleLaneAdapter(doc);
    const cues: readonly Cue[] = [
      {
        schemaVersion: 1,
        cueId: "c1",
        lane: "subtitle",
        anchor: "scene_start",
        offsetMs: 0,
        intent: {},
      },
    ];
    await lane.prepare("s1", cues, new AbortController().signal);
    lane.setSpeechText("s1", "我看看现在的任务进度");
    const line = doc.lines[0]!;
    expect(line.visible).toBe(false);
    expect(line.text).toBe("我看看现在的任务进度");
    await lane.start("s1", 0n, cues);
    expect(line.visible).toBe(true);
    await lane.stop("s1", "cancel");
    expect(line.removed).toBe(true);
    expect(line.visible).toBe(false);
  });

  it("close 撤下全部行", async () => {
    const doc = new FakeSubtitleDocument();
    const lane = new SubtitleLaneAdapter(doc);
    const cues: readonly Cue[] = [
      {
        schemaVersion: 1,
        cueId: "c1",
        lane: "subtitle",
        anchor: "scene_start",
        offsetMs: 0,
        intent: {},
      },
    ];
    await lane.prepare("s1", cues, new AbortController().signal);
    await lane.prepare("s2", cues, new AbortController().signal);
    await lane.close();
    expect(doc.lines.every((line) => line.removed)).toBe(true);
  });
});

describe("RecordingAvatarAdapter", () => {
  const MOTION_CUE: Cue = {
    schemaVersion: 1,
    cueId: "a1",
    lane: "avatar",
    anchor: "speech_start",
    offsetMs: 0,
    intent: { motion: "nod_agree" },
  };

  it("命令顺序记录：prepare → start → stop；未声明动作拒绝", async () => {
    const adapter = new RecordingAvatarAdapter({
      adapter: "recording",
      motions: ["nod_agree"],
      expressions: ["happy"],
    });
    const ok = await adapter.prepare("s1", [MOTION_CUE], new AbortController().signal);
    expect(ok).toEqual({ ready: true });
    await adapter.start("s1", 123_000n, [MOTION_CUE]);
    await adapter.stop("s1", "urgent_interrupt");
    expect(adapter.commands.map((c) => c.kind)).toEqual(["prepare", "start", "stop"]);
    expect(adapter.commands[1]).toMatchObject({ kind: "start", motion: "nod_agree" });

    const unknown = await adapter.prepare(
      "s2",
      [{ ...MOTION_CUE, intent: { motion: "backflip" } }],
      new AbortController().signal,
    );
    expect(unknown).toEqual({ ready: false, reason: "motion_not_found" });
    await adapter.close();
    expect(adapter.commands.at(-1)?.kind).toBe("close");
  });
});
