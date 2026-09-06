import { describe, expect, it } from "vitest";
import { VirtualClock } from "@bellis/testkit";
import { PHASE_2_PCM_FRAME_BYTES } from "@bellis/contracts";
import {
  fakeSpeechProvider,
  frameAt,
  synthesizeSpeech,
} from "../../src/application/phase-2/fake-tts.js";
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
    // 按帧步进时钟（模拟真实节奏；一次性跳过全流会触发迟到丢弃）。
    const stepUs = 20_000n;
    const endUs = 1_000_000n + tts.durationUs + 100_000n;
    for (let t = 0n; t < endUs; t += stepUs) {
      clock.advanceBy(stepUs);
      for (let i = 0; i < 2; i += 1) {
        await Promise.resolve();
      }
    }
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
    expect(sent.length).toBe(tts.frameCount);
    expect(sent[0]?.header.sequence).toBe("0");
    expect(sent[0]?.header.targetTimeUs).toBe("1000000");
    expect(sent[1]?.header.targetTimeUs).toBe("1020000");
    expect(sent.at(-1)?.header.sequence).toBe(String(tts.frameCount - 1));
    expect(sender.sentTotal).toBe(tts.frameCount);
    expect(sender.droppedByLimit).toBe(0);
    sender.close();
  });

  it("迟到超预算帧丢弃重同步：droppedByLimit 计数，sequence 仍严格", async () => {
    const clock = new VirtualClock();
    const sent: { header: Record<string, string | number> }[] = [];
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
      audioCueId: "c",
      streamId: "s",
      sessionId: "sess",
      traceId: "0123456789abcdef0123456789abcdef",
      firstFrameTargetUs: 1_000_000n,
    });
    // 一次性跳过全流（模拟长停顿）：迟到超过阈值（与 Stage Deadline
    // 宽限同族）的帧丢弃重同步，仅尾部仍在窗口内的帧照常送达。
    clock.advanceBy(1_000_000n + tts.durationUs);
    for (let i = 0; i < 40; i += 1) {
      await Promise.resolve();
    }
    expect(sender.droppedByLimit).toBeGreaterThan(0);
    expect(sender.droppedByLimit).toBeLessThan(tts.frameCount);
    expect(sent.length + sender.droppedByLimit).toBe(tts.frameCount);
    // 送达帧 sequence 必须从 0 严格连续（next === previous + 1）：丢帧不
    // 消耗序号，缺号会被 Registry 判 sequence_violation 关闭整个 Stream。
    expect(Number(sent[0]?.header.sequence)).toBe(0);
    for (let i = 1; i < sent.length; i += 1) {
      expect(Number(sent[i]?.header.sequence)).toBe(i);
    }
    expect(sender.sentTotal).toBe(sent.length);
    sender.close();
  });

  it("传输层拒绝的帧不消耗 sequence：后续帧严格连续补位", async () => {
    const clock = new VirtualClock();
    const sent: { header: Record<string, string | number> }[] = [];
    let attempt = 0;
    const sender = new RuntimeMediaSender({
      clock,
      sendFrame: (frame) => {
        attempt += 1;
        // 第 2、3 次交送被传输层拒绝（背压）：帧丢弃，序号不前进。
        const deliver = !(attempt === 2 || attempt === 3);
        if (deliver) {
          sent.push(frame);
        }
        return deliver;
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
    const stepUs = 20_000n;
    const endUs = 1_000_000n + tts.durationUs + 100_000n;
    for (let t = 0n; t < endUs; t += stepUs) {
      clock.advanceBy(stepUs);
      for (let i = 0; i < 2; i += 1) {
        await Promise.resolve();
      }
    }
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
    expect(sender.droppedByTransport).toBe(2);
    expect(sent.length).toBe(tts.frameCount - 2);
    // 被拒帧携带的序号接收方永远看不到：送达帧严格连续 0,1,2,…。
    for (let i = 0; i < sent.length; i += 1) {
      expect(Number(sent[i]?.header.sequence)).toBe(i);
    }
    sender.close();
  });

  it("maxBufferedUs=0 合法生效：零预算下绝不提前发送（只按目标时刻）", async () => {
    const clock = new VirtualClock();
    const sent: { header: Record<string, string | number> }[] = [];
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
      audioCueId: "c",
      streamId: "s",
      sessionId: "sess",
      traceId: "0123456789abcdef0123456789abcdef",
      firstFrameTargetUs: 1_000_000n,
    });
    // Stage 声明零预算（契约允许）：提前量归零——目标前 1µs 都不发。
    sender.updateMaxFutureUs(0n);
    clock.advanceBy(999_999n);
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
    expect(sent).toHaveLength(0);
    clock.advanceBy(60_000n);
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent[0]?.header.targetTimeUs).toBe("1000000");
    sender.close();
  });

  it("迟到恰好达到阈值即丢弃（等号与 Stage Deadline 对齐：≥ 宽限必拒）", async () => {
    const clock = new VirtualClock();
    const sent: { header: Record<string, string | number> }[] = [];
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
      audioCueId: "c",
      streamId: "s",
      sessionId: "sess",
      traceId: "0123456789abcdef0123456789abcdef",
      firstFrameTargetUs: 1_000_000n,
    });
    // 帧目标 1_000_000；时钟推进到 1_100_000 → 帧 0 迟到恰好 100ms
    //（Stage：now−target ≥ 100ms 即 deadline_exceeded）→ 发送侧同判丢弃；
    // 尾部帧（迟到 < 100ms）照常送达。
    clock.advanceBy(1_100_000n);
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
    expect(sender.droppedByLimit).toBeGreaterThanOrEqual(1);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    for (const frame of sent) {
      expect(1_100_000n - BigInt(frame.header.targetTimeUs ?? "1100000")).toBeLessThan(100_000n);
    }
    sender.close();
  });

  it("流生命周期：自然完成与取消都通知 onJobEnd（Stream 关闭依据）", async () => {
    const clock = new VirtualClock();
    const ended: { sceneId: string; streamId: string; reason: string }[] = [];
    const sender = new RuntimeMediaSender({
      clock,
      sendFrame: () => true,
      onJobEnd: (info) => ended.push({ ...info }),
    });
    const tts = synthesizeSpeech(SPEECH);
    sender.startSpeechStream({
      plan: PLAN,
      tts,
      audioCueId: "c",
      streamId: "stream-a",
      sessionId: "sess",
      traceId: "0123456789abcdef0123456789abcdef",
      firstFrameTargetUs: 1_000_000n,
    });
    const stepUs = 20_000n;
    const endUs = 1_000_000n + tts.durationUs + 100_000n;
    for (let t = 0n; t < endUs; t += stepUs) {
      clock.advanceBy(stepUs);
      for (let i = 0; i < 2; i += 1) {
        await Promise.resolve();
      }
    }
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      sceneId: PLAN.scene.sceneId,
      streamId: "stream-a",
      reason: "completed",
    });

    // 第二个流：中途取消 → cancelled 通知。
    const endedBefore = ended.length;
    sender.startSpeechStream({
      plan: {
        ...PLAN,
        scene: { ...PLAN.scene, sceneId: "44444444-4444-4444-8444-4444440000bb" },
      } as ScenePlan,
      tts,
      audioCueId: "c",
      streamId: "stream-b",
      sessionId: "sess",
      traceId: "0123456789abcdef0123456789abcdef",
      firstFrameTargetUs: 5_000_000n,
    });
    sender.cancelStream("44444444-4444-4444-8444-4444440000bb", "urgent_interrupt");
    expect(ended.length).toBe(endedBefore + 1);
    expect(ended.at(-1)?.reason).toBe("cancelled");
    expect(ended.at(-1)?.streamId).toBe("stream-b");
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

it("lazy fake PCM matches the buffered fixture and observes cancellation", async () => {
  const expected = synthesizeSpeech(SPEECH);
  const controller = new AbortController();
  const iterator = fakeSpeechProvider.stream(SPEECH, controller.signal)[Symbol.asyncIterator]();
  for (let index = 0; index < 3; index += 1) {
    expect((await iterator.next()).value).toEqual(frameAt(expected, index));
  }
  controller.abort();
  await expect(iterator.next()).rejects.toThrow();
});

it("pulls streaming frames on demand and closes the provider after cancellation", async () => {
  const clock = new VirtualClock();
  let pulled = 0;
  let released = false;
  let aborted = false;
  const sender = new RuntimeMediaSender({ clock, sendFrame: () => true });
  sender.startSpeechStream({
    plan: PLAN,
    tts: {
      async *frames(signal) {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
          },
          { once: true },
        );
        try {
          while (!signal.aborted) {
            pulled += 1;
            yield new Uint8Array(PHASE_2_PCM_FRAME_BYTES);
          }
        } finally {
          released = true;
        }
      },
    },
    audioCueId: "c",
    streamId: "s",
    sessionId: "session",
    traceId: "0123456789abcdef0123456789abcdef",
    firstFrameTargetUs: 1_000_000n,
  });
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  expect(pulled).toBe(1);
  sender.cancelStream(PLAN.scene.sceneId, "interrupt");
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  expect(aborted).toBe(true);
  expect(released).toBe(true);
  expect(pulled).toBe(1);
  expect(sender.sentTotal).toBe(0);
  expect(sender.activeJobs).toBe(0);
  expect(clock.pendingCount()).toBe(0);
  sender.close();
});
