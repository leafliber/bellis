import { describe, expect, it } from "vitest";
import { VirtualClock } from "@bellis/testkit";
import { PHASE_2_PCM_FRAME_BYTES } from "@bellis/contracts";
import { frameAt, synthesizeSpeech } from "../../src/application/phase-2/fake-tts.js";
import { RuntimeMediaSender } from "../../src/application/phase-2/media-sender.js";
import type { ScenePlan } from "@bellis/contracts";

/**
 * Fake TTS 确定性与 Media Sender 三重限制/取消优先测试
 * （docs/phase-2-development-guide.md §8.1）。
 */

const SPEECH = {
  schemaVersion: 1,
  text: "我看看现在的任务进度",
  purpose: "tool_notice",
  interruptible: true,
} as const;

const PLAN = {
  schemaVersion: 1,
  scene: {
    schemaVersion: 1,
    sceneId: "44444444-4444-4444-8444-444444444444",
    cycleId: "33333333-3333-4333-8333-333333333333",
    groups: [
      {
        schemaVersion: 1,
        groupId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        lanes: ["audio"],
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
      intent: { speechRef: "plan" },
    },
  ],
} as unknown as ScenePlan;

describe("fake TTS", () => {
  it("相同输入逐字节确定；不同输入不同波形", () => {
    const a = synthesizeSpeech(SPEECH);
    const b = synthesizeSpeech(SPEECH);
    expect(Array.from(a.pcm)).toEqual(Array.from(b.pcm));
    expect(a.durationUs).toBe(b.durationUs);
    expect(a.wordStartOffsetsUs).toEqual(b.wordStartOffsetsUs);
    const other = synthesizeSpeech({ ...SPEECH, text: "完全不同的一句话" });
    expect(other.pcm.byteLength).not.toBe(a.pcm.byteLength);
  });

  it("输出恒为帧对齐：durationUs 是 20ms 整数倍，字节数 = 帧 × 1920", () => {
    const result = synthesizeSpeech(SPEECH);
    expect(result.durationUs % 20_000n).toBe(0n);
    expect(result.pcm.byteLength).toBe(result.frameCount * PHASE_2_PCM_FRAME_BYTES);
    expect(frameAt(result, 0)?.byteLength).toBe(PHASE_2_PCM_FRAME_BYTES);
    expect(frameAt(result, result.frameCount)).toBeNull();
  });

  it("词边界单调且覆盖文本", () => {
    const result = synthesizeSpeech({ ...SPEECH, text: "hello world" });
    expect(result.wordStartOffsetsUs).toHaveLength(2);
    expect(result.wordStartOffsetsUs[1]!).toBeGreaterThan(result.wordStartOffsetsUs[0]!);
  });
});

describe("RuntimeMediaSender", () => {
  it("按目标时刻发送完整流；sequence 连续、targetTime 等差", async () => {
    const clock = new VirtualClock();
    const sent: { header: Record<string, string | number>; payload: Uint8Array }[] = [];
    const sender = new RuntimeMediaSender({
      clock,
      sendFrame: (frame) => {
        sent.push(frame);
        return true;
      },
    });
    const tts = synthesizeSpeech(SPEECH);
    sender.startSpeechStream({
      plan: PLAN,
      tts,
      audioCueId: "55555555-5555-4555-8555-555555555555",
      streamId: "99999999-9999-4999-8999-999999999999",
      sessionId: "11111111-1111-4111-8111-111111111111",
      traceId: "0123456789abcdef0123456789abcdef",
      firstFrameTargetUs: 1_000_000n,
    });
    // 推进到全部帧的目标时刻之后。
    clock.advanceBy(1_000_000n + tts.durationUs + 100_000n);
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
    expect(sent.length).toBe(tts.frameCount);
    expect(sent[0]?.header.sequence).toBe("0");
    expect(sent[0]?.header.targetTimeUs).toBe("1000000");
    expect(sent[1]?.header.targetTimeUs).toBe("1020000");
    expect(sent.at(-1)?.header.sequence).toBe(String(tts.frameCount - 1));
    expect(sender.sentTotal).toBe(tts.frameCount);
    sender.close();
  });

  it("取消优先：cancel 后立即停止产生新帧", async () => {
    const clock = new VirtualClock();
    const sent: unknown[] = [];
    const sender = new RuntimeMediaSender({
      clock,
      sendFrame: () => {
        sent.push(1);
        return true;
      },
    });
    const tts = synthesizeSpeech(SPEECH);
    sender.startSpeechStream({
      plan: PLAN,
      tts,
      audioCueId: "c",
      streamId: "s",
      sessionId: "sess",
      traceId: "0123456789abcdef0123456789abcdef",
      firstFrameTargetUs: 1_000_000n,
    });
    clock.advanceBy(1_500_000n); // 少量帧已发
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
    const sentBeforeCancel = sent.length;
    expect(sentBeforeCancel).toBeGreaterThan(0);
    sender.cancelStream(PLAN.scene.sceneId, "urgent_interrupt");
    clock.advanceBy(tts.durationUs * 2n);
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
    expect(sent.length).toBe(sentBeforeCancel);
    expect(sender.activeJobs).toBe(0);
    sender.close();
  });

  it("未来时长超预算时暂停发送（时钟追赶后恢复）", async () => {
    const clock = new VirtualClock();
    const sent: unknown[] = [];
    const sender = new RuntimeMediaSender({
      clock,
      limits: { maxFutureUs: 100_000n, maxQueuedFrames: 128, maxQueuedBytes: 1 << 20 },
      sendFrame: () => {
        sent.push(1);
        return true;
      },
    });
    const tts = synthesizeSpeech(SPEECH);
    sender.startSpeechStream({
      plan: PLAN,
      tts,
      audioCueId: "c",
      streamId: "s",
      sessionId: "sess",
      traceId: "0123456789abcdef0123456789abcdef",
      firstFrameTargetUs: 5_000_000n, // 远未来
    });
    clock.advanceBy(4_000_000n); // lead 仍有 1s > 100ms 预算：一帧都不发
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
    expect(sent.length).toBe(0);
    clock.advanceBy(2_000_000n); // 追赶到目标之后：恢复发送
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
    expect(sent.length).toBeGreaterThan(0);
    sender.close();
  });
});
