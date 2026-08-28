import { describe, expect, it } from "vitest";
import { VirtualClock } from "@bellis/testkit";
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

  /** 测试驱动：模拟 Worklet「已放完全部样本」（真实完成信号）。 */
  reportEnded(sceneId: string): void {
    this.#handler?.({ v: 1, op: "ended", sceneId });
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
    const lane = new AudioLaneAdapter({ environment: env, clock: new VirtualClock() });
    const result = await lane.prepare("s1", AUDIO_CUES, new AbortController().signal);
    expect(result).toEqual({ ready: false, reason: "audio_not_armed" });
  });

  it("Arm 后 prepare 等待预缓冲达标；start 在播放完成（ended）时才兑现", async () => {
    const env = new FakeAudioEnvironment();
    const clock = new VirtualClock();
    const lane = new AudioLaneAdapter({ environment: env, clock, minPreparedFrames: 3 });
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
    // start 立即切换 generation，但 Promise 未兑现（播放未完成）。
    let started = false;
    const starting = lane.start("s1", 0n, AUDIO_CUES).then(() => {
      started = true;
    });
    expect(env.messages.at(-1)).toMatchObject({ op: "switch", sceneId: "s1" });
    await Promise.resolve();
    expect(started).toBe(false);
    // EOS（closed 到达）→ 尾帧宽限 → Worklet end op → ended 回报 → 完成。
    lane.endOfSpeech("s1");
    clock.advanceBy(100_000n);
    await Promise.resolve();
    expect(env.messages.some((m) => m.op === "end" && m.sceneId === "s1")).toBe(true);
    expect(started).toBe(false); // end op 已发，等待真实放完回报。
    env.reportEnded("s1");
    await starting;
    expect(started).toBe(true);
    env.reportStats(2);
    expect(lane.underruns).toBe(2);
    await lane.close();
  });

  it("EOS 完成兜底截止：ended 回报缺失时按预期放完时刻 + 宽限兑现", async () => {
    const env = new FakeAudioEnvironment();
    const clock = new VirtualClock();
    const lane = new AudioLaneAdapter({ environment: env, clock, minPreparedFrames: 1 });
    await lane.arm();
    lane.appendFrame("s1", new Int16Array(960)); // 20ms
    await lane.prepare("s1", AUDIO_CUES, new AbortController().signal);
    const starting = lane.start("s1", 0n, AUDIO_CUES);
    lane.endOfSpeech("s1");
    // 宽限窗内到达的跨连接尾帧：继续入账（closing ≠ EOS 已转发）。
    const framesBefore = lane.bufferedFrames.get("s1") ?? 0;
    lane.appendFrame("s1", new Int16Array(960));
    expect(lane.bufferedFrames.get("s1")).toBe(framesBefore + 1);
    clock.advanceBy(100_000n); // 尾帧宽限 → end op（此后拒绝追加）
    await Promise.resolve();
    lane.appendFrame("s1", new Int16Array(960));
    expect(lane.bufferedFrames.get("s1")).toBe(framesBefore + 1);
    // 不驱动 ended：兜底 = start(0) + 40ms 播放 + 100ms EOS 宽限。
    clock.advanceBy(1_040_000n);
    await starting;
    expect(env.messages.some((m) => m.op === "end" && m.sceneId === "s1")).toBe(true);
    await lane.close();
  });

  it("零帧流：EOS 即完成（无 end op、无等待）；prepare 释放为未达标", async () => {
    const env = new FakeAudioEnvironment();
    const clock = new VirtualClock();
    const lane = new AudioLaneAdapter({ environment: env, clock, minPreparedFrames: 3 });
    await lane.arm();
    const preparing = lane.prepare("s1", AUDIO_CUES, new AbortController().signal);
    lane.endOfSpeech("s1");
    clock.advanceBy(100_000n);
    const result = await preparing;
    expect(result).toEqual({ ready: false, reason: "prebuffer_timeout" });
    expect(env.messages.some((m) => m.op === "end")).toBe(false);
    await lane.close();
  });

  it("stop 立即兑现未完成的 start（取消优先于媒体）；clearAll 清空全部", async () => {
    const env = new FakeAudioEnvironment();
    const clock = new VirtualClock();
    const lane = new AudioLaneAdapter({ environment: env, clock, minPreparedFrames: 1 });
    await lane.arm();
    lane.appendFrame("s1", new Int16Array(960)); // 帧先行：prepare 立即达标
    await lane.prepare("s1", AUDIO_CUES, new AbortController().signal);
    let started = false;
    void lane.start("s1", 0n, AUDIO_CUES).then(() => {
      started = true;
    });
    await lane.stop("s1", "urgent_interrupt");
    await Promise.resolve();
    expect(started).toBe(true); // 取消路径不悬挂 scene.finished
    expect(env.messages).toContainEqual({ v: 1, op: "cancel", sceneId: "s1" });
    const frameMessages = env.messages.filter((message) => message.op === "frame").length;
    lane.appendFrame("s1", new Int16Array(960)); // Cancel 后在途媒体尾帧
    lane.endOfSpeech("s1"); // closed 也不得重建主线程 Scene 记录
    expect(env.messages.filter((message) => message.op === "frame")).toHaveLength(frameMessages);
    expect(lane.bufferedFrames.has("s1")).toBe(false);
    lane.clearAll();
    expect(env.messages.at(-1)?.op).toBe("clear");
    lane.appendFrame("s1", new Int16Array(960)); // 新连接代际清除 Cancel 墓碑
    expect(lane.bufferedFrames.get("s1")).toBe(1);
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

const SUBTITLE_CUES: readonly Cue[] = [
  {
    schemaVersion: 1,
    cueId: "c1",
    lane: "subtitle",
    anchor: "scene_start",
    offsetMs: 0,
    intent: {},
  },
];

describe("SubtitleLaneAdapter", () => {
  it("prepare 只创建不可见行；start 显示；endOfSpeech 按时长撤下并完成；文本经文本节点", async () => {
    const doc = new FakeSubtitleDocument();
    const clock = new VirtualClock();
    const lane = new SubtitleLaneAdapter({ document: doc, clock });
    await lane.prepare("s1", SUBTITLE_CUES, new AbortController().signal);
    lane.setSpeechText("s1", "我看看现在的任务进度");
    const line = doc.lines[0]!;
    expect(line.visible).toBe(false);
    expect(line.text).toBe("我看看现在的任务进度");
    let started = false;
    // 生效目标时刻 = 200ms（Commit 映射锚点；时钟此刻 0：预缓冲期）。
    const starting = lane.start("s1", 200_000n, SUBTITLE_CUES).then(() => {
      started = true;
    });
    expect(line.visible).toBe(true);
    await Promise.resolve();
    expect(started).toBe(false); // 显示 ≠ 完成
    // 发言时长 600ms（closed 边界推导）：撤下时刻 = 锚点 200ms + 600ms。
    lane.endOfSpeech("s1", 600_000n);
    clock.advanceBy(300_000n);
    await Promise.resolve();
    expect(line.visible).toBe(true);
    expect(started).toBe(false);
    clock.advanceBy(300_000n);
    await Promise.resolve();
    expect(started).toBe(false); // 未到锚点+时长（800ms）
    clock.advanceBy(200_000n);
    await starting;
    expect(started).toBe(true);
    expect(line.visible).toBe(false);
    // 真实可见区间记录（E2E 断言依据）。
    const interval = lane.visibleIntervals().at(-1);
    expect(interval?.sceneId).toBe("s1");
    expect(
      interval && interval.hiddenAtUs !== null && interval.hiddenAtUs > interval.shownAtUs,
    ).toBe(true);
    await lane.stop("s1", "cancel");
    expect(line.removed).toBe(true);
  });

  it("stop 立即撤下并兑现 start（取消不悬挂）；close 撤下全部行", async () => {
    const doc = new FakeSubtitleDocument();
    const lane = new SubtitleLaneAdapter({ document: doc, clock: new VirtualClock() });
    await lane.prepare("s1", SUBTITLE_CUES, new AbortController().signal);
    let started = false;
    void lane.start("s1", 0n, SUBTITLE_CUES).then(() => {
      started = true;
    });
    await lane.stop("s1", "cancel");
    await Promise.resolve();
    expect(started).toBe(true);
    expect(doc.lines[0]?.removed).toBe(true);
    expect(doc.lines[0]?.visible).toBe(false);

    await lane.prepare("s2", SUBTITLE_CUES, new AbortController().signal);
    await lane.prepare("s3", SUBTITLE_CUES, new AbortController().signal);
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
    intent: { motion: "nod_agree", durationMs: 1200 },
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
