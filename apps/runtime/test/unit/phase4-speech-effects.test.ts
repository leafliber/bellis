import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ScenePlanSchema, type AudioSegmentBinding, type SpeechIntent } from "@bellis/contracts";
import {
  prepareSpeechEffects,
  speechSegmentRanges,
  streamSpeechEffectSegments,
} from "../../src/application/phase-4/speech-effects.js";

function fixture(text = "你好。再见！") {
  const cueId = randomUUID();
  const speech: SpeechIntent = { schemaVersion: 1, text, purpose: "answer", interruptible: true };
  const original = ScenePlanSchema.parse({
    schemaVersion: 1,
    scene: {
      schemaVersion: 1,
      sceneId: randomUUID(),
      cycleId: randomUUID(),
      deadlineMs: 500,
      interruptPolicy: "fade",
      groups: [
        { schemaVersion: 1, groupId: randomUUID(), lanes: ["audio", "subtitle"], level: "hard" },
      ],
    },
    cues: [
      {
        schemaVersion: 1,
        cueId,
        lane: "audio",
        anchor: "scene_start",
        offsetMs: 0,
        intent: { speechRef: "plan" },
      },
      {
        schemaVersion: 1,
        cueId: randomUUID(),
        lane: "subtitle",
        anchor: "scene_start",
        offsetMs: 0,
        intent: { speechRef: "plan" },
      },
    ],
    speech,
  });
  return {
    speech,
    plan: prepareSpeechEffects(original, {
      sessionId: randomUUID(),
      connectionGeneration: randomUUID(),
    }),
  };
}

describe("Phase 4 speech segment synthesis", () => {
  it("preserves all text, surrogate pairs, closers and decimals within a bounded sentence policy", () => {
    for (const text of ["你好🙂。‘再见！’ 结束", "值是3.14。\n下一句", "一句。".repeat(100)]) {
      const ranges = speechSegmentRanges(text);
      expect(ranges.length).toBeLessThanOrEqual(32);
      expect(ranges.map((range) => text.slice(range.start, range.end)).join("")).toBe(text);
      for (const range of ranges)
        expect(Buffer.from(text.slice(range.start, range.end)).toString("utf8")).toBe(
          text.slice(range.start, range.end),
        );
    }
    expect(speechSegmentRanges("值是3.14。下一句")[0]).toEqual({ start: 0, end: 7 });
  });

  it("binds actual sample counts before releasing each segment's final frame and copies provider buffers", async () => {
    const f = fixture();
    const bindings: AudioSegmentBinding[] = [];
    const calls: string[] = [];
    const events: string[] = [];
    const received: number[] = [];
    const provider = {
      async *stream(speech: SpeechIntent) {
        calls.push(speech.text);
        const buffer = new Uint8Array(1920);
        for (let index = 1; index <= 3; index++) {
          buffer.fill(index);
          yield buffer;
        }
      },
    };
    for await (const frame of streamSpeechEffectSegments({
      ...f,
      streamId: randomUUID(),
      provider,
      signal: new AbortController().signal,
      bind: async (binding) => {
        events.push("binding");
        bindings.push(binding);
      },
    })) {
      received.push(frame[0]!);
      events.push("frame");
    }
    expect(calls).toEqual(["你好。", "再见！"]);
    expect(received).toEqual([1, 2, 3, 1, 2, 3]);
    expect(events).toEqual([
      "frame",
      "frame",
      "binding",
      "frame",
      "frame",
      "frame",
      "binding",
      "frame",
    ]);
    expect(bindings.map((binding) => [binding.startSample, binding.endSample])).toEqual([
      [0, 2880],
      [2880, 5760],
    ]);
    expect(f.plan.effects!.segments.every((segment) => segment.lane === "audio")).toBe(true);
  });

  it("never binds a failed or cancelled segment and never releases its held final frame after binding failure", async () => {
    for (const failure of ["provider", "binding", "abort"] as const) {
      const f = fixture("完整片段。");
      const controller = new AbortController();
      const bindings: AudioSegmentBinding[] = [];
      const frames: Uint8Array[] = [];
      const source = streamSpeechEffectSegments({
        ...f,
        streamId: randomUUID(),
        signal: controller.signal,
        provider: {
          async *stream() {
            yield new Uint8Array(1920);
            yield new Uint8Array(1920);
            if (failure === "provider") throw new Error("synthesis_failed");
            if (failure === "abort") controller.abort(new Error("cancelled"));
          },
        },
        bind: async (binding) => {
          if (failure === "binding") throw new Error("database_unavailable");
          bindings.push(binding);
        },
      });
      await expect(
        (async () => {
          for await (const frame of source) frames.push(frame);
        })(),
      ).rejects.toThrow();
      expect(bindings).toEqual([]);
      expect(frames).toHaveLength(1);
    }
  });
});
