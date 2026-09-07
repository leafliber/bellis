import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { VirtualClock } from "@bellis/testkit";
import type { AudioSegmentBinding, ScenePlan, StageEffectReceipt } from "@bellis/contracts";
import { StageEffectTracker } from "../../src/scenes/effect-tracker.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture(lane: "audio" | "subtitle" = "audio") {
  const sessionId = randomUUID(),
    sceneId = randomUUID(),
    cueId = randomUUID(),
    streamId = randomUUID();
  const text = "你好。再见！";
  const effects = {
    schemaVersion: 1 as const,
    sessionId,
    connectionGeneration: randomUUID(),
    contentHash: hash(text),
    textLength: text.length,
    segments: [0, 3].map((start) => ({
      segmentId: randomUUID(),
      cueId,
      lane,
      start,
      end: start + 3,
      textHash: hash(text.slice(start, start + 3)),
    })),
  };
  const plan = {
    schemaVersion: 1,
    scene: { sceneId },
    cues: [{ cueId, lane }],
    speech: { text },
    effects,
  } as unknown as ScenePlan;
  const bindings: AudioSegmentBinding[] = effects.segments.map((segment, index) => ({
    schemaVersion: 1,
    sessionId,
    connectionGeneration: effects.connectionGeneration,
    sceneId,
    cueId,
    contentHash: effects.contentHash,
    segmentId: segment.segmentId,
    streamId,
    sampleRateHz: 48000,
    startSample: index * 1920,
    endSample: (index + 1) * 1920,
  }));
  const sent: StageEffectReceipt[] = [];
  const releases: unknown[] = [];
  const clock = new VirtualClock();
  const tracker = new StageEffectTracker({
    sessionId,
    clock,
    send: (_, receipt) => {
      if ("receiptId" in receipt) sent.push(receipt);
      else releases.push(receipt);
      return true;
    },
  });
  const ack = (receipt: StageEffectReceipt) =>
    tracker.acknowledge({
      schemaVersion: 1,
      sessionId,
      connectionGeneration: effects.connectionGeneration,
      sceneId,
      receiptId: receipt.receiptId,
      outcome: "recorded",
      reason: null,
    });
  return { tracker, sent, releases, clock, plan, bindings, sceneId, effects, ack };
}

describe("Stage effect confirmation", () => {
  it("retains pending receipts beyond terminal grace and retries release until Runtime acknowledges it", async () => {
    const f = fixture("subtitle");
    await f.tracker.prepare(f.plan);
    f.tracker.commit(f.sceneId);
    f.tracker.subtitleApplied(f.sceneId, 0, 6, 1n);
    f.tracker.finish(f.sceneId);
    f.clock.advanceBy(10_000_000n);
    f.tracker.flush();
    expect(f.releases).toEqual([]);
    expect(f.tracker.pendingCount).toBe(2);
    f.tracker.seal({
      schemaVersion: 1,
      sessionId: f.effects.sessionId,
      connectionGeneration: f.effects.connectionGeneration,
      sceneId: f.sceneId,
      bindings: [],
    });
    f.ack(f.sent[0]!);
    f.ack(f.sent[1]!);
    f.tracker.flush();
    expect(f.releases).toHaveLength(1);
    const release = f.releases[0];
    f.clock.advanceBy(250_000n);
    f.tracker.flush();
    expect(f.releases).toEqual([release, release]);
    f.tracker.released(release);
    f.clock.advanceBy(250_000n);
    f.tracker.flush();
    expect(f.releases).toHaveLength(2);
  });

  it("retains rendered progress until the final binding prefix arrives even after a minute", async () => {
    const f = fixture();
    await f.tracker.prepare(f.plan);
    f.tracker.commit(f.sceneId);
    f.tracker.audioRendered(f.sceneId, 3000, 3n);
    f.tracker.finish(f.sceneId);
    f.clock.advanceBy(60_000_000n);
    f.tracker.flush();
    expect(f.sent).toEqual([]);
    expect(f.releases).toEqual([]);
    const seal = {
      schemaVersion: 1,
      sessionId: f.effects.sessionId,
      connectionGeneration: f.effects.connectionGeneration,
      sceneId: f.sceneId,
      bindings: f.bindings,
    };
    f.tracker.seal({ ...seal, connectionGeneration: randomUUID() });
    expect(f.sent).toEqual([]);
    f.tracker.seal(seal);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ start: 0, end: 3, renderedSamples: 3000 });
    f.tracker.seal(seal);
    expect(f.sent).toHaveLength(1);
    f.ack(f.sent[0]!);
    f.tracker.flush();
    expect(f.releases).toHaveLength(1);
  });

  it("emits complete increments only after rendered boundaries, never from prepare or the other Lane", async () => {
    const f = fixture();
    expect(await f.tracker.prepare(f.plan)).toBe(true);
    for (const binding of f.bindings) f.tracker.bindAudio(binding);
    f.tracker.audioRendered(f.sceneId, 3840, 1n);
    expect(f.sent).toEqual([]);
    f.tracker.commit(f.sceneId);
    f.tracker.subtitleApplied(f.sceneId, 0, 6, 2n);
    f.tracker.audioRendered(f.sceneId, 1919, 3n);
    expect(f.sent).toEqual([]);
    f.tracker.audioRendered(f.sceneId, 1920, 4n);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ start: 0, end: 3, renderedSamples: 1920 });
    f.tracker.audioRendered(f.sceneId, 3000, 5n);
    f.tracker.finish(f.sceneId);
    f.tracker.audioRendered(f.sceneId, 3840, 6n);
    expect(f.sent).toHaveLength(1);
    expect(f.tracker.pendingCount).toBe(1);
    f.ack(f.sent[0]!);
    expect(f.tracker.pendingCount).toBe(0);
  });

  it("handles a late binding after cancellation and replays the identical receipt until durable ACK", async () => {
    const f = fixture();
    f.tracker.bindAudio(f.bindings[1]); // Control delivery can precede prepare.
    await f.tracker.prepare(f.plan);
    f.tracker.commit(f.sceneId);
    f.tracker.audioRendered(f.sceneId, 3000, 4n);
    expect(f.sent).toEqual([]); // The missing prefix binding cannot be guessed.
    f.tracker.finish(f.sceneId);
    f.tracker.bindAudio(f.bindings[0]);
    expect(f.sent).toHaveLength(1);
    f.clock.advanceBy(250_000n);
    f.tracker.flush();
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toBe(f.sent[0]);
    f.tracker.acknowledge({
      schemaVersion: 1,
      sessionId: randomUUID(),
      connectionGeneration: f.effects.connectionGeneration,
      sceneId: f.sceneId,
      receiptId: f.sent[0]!.receiptId,
      outcome: "recorded",
      reason: null,
    });
    expect(f.tracker.pendingCount).toBe(1);
    f.ack(f.sent[0]!);
    f.clock.advanceBy(250_000n);
    f.tracker.flush();
    expect(f.sent).toHaveLength(2);
  });

  it("validates frozen text and ranges, rejects binding conflicts, and clears across connection generations", async () => {
    const f = fixture();
    const forged = structuredClone(f.plan);
    forged.speech = { text: "伪造内容" };
    expect(await f.tracker.prepare(forged)).toBe(false);
    const broken = structuredClone(f.plan);
    broken.effects!.segments[1]!.start = 2;
    expect(await f.tracker.prepare(broken)).toBe(false);
    await f.tracker.prepare(f.plan);
    f.tracker.commit(f.sceneId);
    f.tracker.bindAudio(f.bindings[0]);
    f.tracker.bindAudio({ ...f.bindings[0], endSample: 960 });
    f.tracker.audioRendered(f.sceneId, 1920, 1n);
    expect(f.sent).toEqual([]);
    f.tracker.clear();
    f.tracker.bindAudio(f.bindings[0]);
    f.tracker.audioRendered(f.sceneId, 1920, 2n);
    expect(f.sent).toEqual([]);
    f.tracker.bindAudio({ ...f.bindings[0], endSample: 960 });
    await f.tracker.prepare(f.plan);
    f.tracker.commit(f.sceneId);
    f.tracker.audioRendered(f.sceneId, 1920, 3n);
    expect(f.sent).toEqual([]);
  });

  it("confirms subtitle segments only from an exact applied range and reserves bounded receipts", async () => {
    const f = fixture("subtitle");
    await f.tracker.prepare(f.plan);
    f.tracker.subtitleApplied(f.sceneId, 0, 6, 1n);
    expect(f.sent).toEqual([]);
    f.tracker.commit(f.sceneId);
    f.tracker.subtitleApplied(f.sceneId, 0, 3, 2n);
    expect(f.sent).toEqual([]);
    f.tracker.subtitleApplied(f.sceneId, 0, 6, 3n);
    f.tracker.subtitleApplied(f.sceneId, 0, 6, 4n);
    expect(f.sent).toHaveLength(2);
    expect(f.sent.map((receipt) => [receipt.start, receipt.end])).toEqual([
      [0, 3],
      [3, 6],
    ]);
    for (let i = 0; i < 3; i++) {
      const other = structuredClone(f.plan);
      other.scene.sceneId = randomUUID();
      expect(await f.tracker.prepare(other)).toBe(true);
    }
    const overflow = structuredClone(f.plan);
    overflow.scene.sceneId = randomUUID();
    expect(await f.tracker.prepare(overflow)).toBe(false);
    f.tracker.clear();
    expect(f.tracker.pendingCount).toBe(0);
  });
});
