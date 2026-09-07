import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ScenePlanSchema,
  type AudioSegmentBinding,
  type JsonValue,
  type StageEffectAck,
  type StageEffectReceipt,
} from "@bellis/contracts";
import type { PersistenceClient } from "@bellis/persistence";
import { Phase4EffectsHost } from "../../src/application/phase-4/effects-host.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let generation: string | null = randomUUID();
  const sessionId = randomUUID();
  const messages: { type: string; payload: JsonValue }[] = [];
  const writes: string[] = [];
  const prepared = deferred<void>();
  const confirmed = deferred<StageEffectAck>();
  const persistence = {
    phase4PrepareEffects: vi.fn(() => {
      writes.push("prepare");
      return prepared.promise;
    }),
    phase4BindAudioSegment: vi.fn(async () => {
      writes.push("bind");
    }),
    phase4ConfirmEffect: vi.fn(() => confirmed.promise),
    phase4CloseEffects: vi.fn(async () => {}),
  };
  const host = new Phase4EffectsHost({
    persistence: persistence as unknown as PersistenceClient,
    targets: () => [],
    onError: vi.fn(),
    channel: {
      activeConnectionId: () => generation,
      hasStageConnection: () => generation !== null,
      onDisconnected: () => {},
      enqueueServerMessage: (message) => {
        messages.push(message);
        return true;
      },
    },
  });
  const original = ScenePlanSchema.parse({
    schemaVersion: 1,
    scene: {
      schemaVersion: 1,
      sceneId: randomUUID(),
      cycleId: randomUUID(),
      groups: [{ schemaVersion: 1, groupId: randomUUID(), lanes: ["audio"], level: "hard" }],
      deadlineMs: 500,
      interruptPolicy: "fade",
    },
    cues: [
      {
        schemaVersion: 1,
        cueId: randomUUID(),
        lane: "audio",
        anchor: "scene_start",
        offsetMs: 0,
        intent: { speechRef: "plan" },
      },
    ],
    speech: { schemaVersion: 1, text: "已完成。", purpose: "answer", interruptible: true },
  });
  const plan = host.prepare(original, sessionId, generation, "a".repeat(32));
  const effects = plan.effects!;
  const segment = effects.segments[0]!;
  const binding: AudioSegmentBinding = {
    schemaVersion: 1,
    sessionId,
    connectionGeneration: generation,
    sceneId: plan.scene.sceneId,
    cueId: segment.cueId,
    segmentId: segment.segmentId,
    contentHash: effects.contentHash,
    streamId: randomUUID(),
    sampleRateHz: 48000,
    startSample: 0,
    endSample: 1920,
  };
  const receipt: StageEffectReceipt = {
    schemaVersion: 1,
    sessionId,
    connectionGeneration: generation,
    sceneId: plan.scene.sceneId,
    cueId: segment.cueId,
    segmentId: segment.segmentId,
    contentHash: effects.contentHash,
    receiptId: randomUUID(),
    start: 0,
    end: 4,
    appliedAtStageUs: "20000",
    lane: "audio",
    boundary: "worklet_rendered",
    renderedSamples: 1920,
    streamId: binding.streamId,
  };
  const ack: StageEffectAck = {
    schemaVersion: 1,
    sessionId,
    connectionGeneration: generation,
    sceneId: plan.scene.sceneId,
    receiptId: receipt.receiptId,
    outcome: "recorded",
    reason: null,
  };
  return {
    host,
    persistence,
    prepared,
    confirmed,
    plan,
    binding,
    receipt,
    ack,
    messages,
    writes,
    sessionId,
    generation,
    reconnect: () => {
      generation = randomUUID();
    },
  };
}

describe("Phase 4 effects host", () => {
  it("seals only after an in-flight DB binding settles, including accepted work whose caller was cancelled", async () => {
    const f = fixture();
    const written = deferred<void>();
    f.persistence.phase4BindAudioSegment.mockImplementation(() => written.promise);
    const controller = new AbortController();
    try {
      f.prepared.resolve();
      const binding = f.host.bind(f.binding, controller.signal);
      await vi.waitFor(() => expect(f.persistence.phase4BindAudioSegment).toHaveBeenCalledTimes(1));
      f.host.sent(f.plan.scene.sceneId);
      f.host.finish(f.plan.scene.sceneId);
      controller.abort(new Error("cancelled"));
      await expect(binding).rejects.toThrow("cancelled");
      expect(f.messages).toEqual([]);
      written.resolve();
      await vi.waitFor(() =>
        expect(f.messages.some((message) => message.type === "scene.effect.seal")).toBe(true),
      );
      expect(f.messages.find((message) => message.type === "scene.effect.seal")).toMatchObject({
        payload: { bindings: [f.binding] },
      });
      expect(f.messages.some((message) => message.type === "scene.effect.binding")).toBe(false);
    } finally {
      written.resolve();
      f.prepared.resolve();
      await f.host.close();
    }
  });
  it("retains dispatched terminal capacity through an outage until Stage releases after durable ACK", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const receipts = () => f.messages.filter((message) => message.type !== "scene.effect.seal");
    try {
      f.prepared.resolve();
      f.host.sent(f.plan.scene.sceneId);
      const release = {
        schemaVersion: 1,
        sessionId: f.sessionId,
        connectionGeneration: f.generation,
        sceneId: f.plan.scene.sceneId,
      };
      f.host.release(release, f.sessionId, f.generation);
      expect(f.persistence.phase4CloseEffects).not.toHaveBeenCalled();
      f.host.finish(f.plan.scene.sceneId);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.persistence.phase4CloseEffects).not.toHaveBeenCalled();
      f.host.receive(f.receipt, f.sessionId, f.generation);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(receipts()).toEqual([]);
      f.confirmed.resolve(f.ack);
      await vi.advanceTimersByTimeAsync(0);
      expect(receipts()[0]).toMatchObject({ type: "scene.effect.ack" });
      f.host.release(release, f.sessionId, f.generation);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.persistence.phase4CloseEffects).toHaveBeenCalledTimes(1);
      expect(receipts()[1]).toMatchObject({ type: "scene.effect.released", payload: release });
      f.host.release(release, f.sessionId, f.generation);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.persistence.phase4CloseEffects).toHaveBeenCalledTimes(1);
      expect(receipts()).toHaveLength(3);
    } finally {
      f.prepared.resolve();
      await f.host.close();
      vi.useRealTimers();
    }
  });
  it("waits for durable preparation before binding and sends binding only after DB acceptance", async () => {
    const f = fixture();
    try {
      const binding = f.host.bind(f.binding, new AbortController().signal);
      await Promise.resolve();
      expect(f.writes).toEqual(["prepare"]);
      expect(f.messages).toEqual([]);
      f.prepared.resolve();
      await binding;
      expect(f.writes).toEqual(["prepare", "bind"]);
      expect(f.messages).toEqual([
        { type: "scene.effect.binding", payload: f.binding, trace: { traceId: "a".repeat(32) } },
      ]);
    } finally {
      f.prepared.resolve();
      await f.host.close();
    }
  });
  it("aborts a wait without publishing and rejects bindings from a replaced connection", async () => {
    const f = fixture();
    try {
      const controller = new AbortController();
      const pending = f.host.bind(f.binding, controller.signal);
      controller.abort(new Error("cancelled"));
      await expect(pending).rejects.toThrow("cancelled");
      f.prepared.resolve();
      f.reconnect();
      await expect(f.host.bind(f.binding, new AbortController().signal)).rejects.toThrow(
        "effect_connection_changed",
      );
      expect(f.persistence.phase4BindAudioSegment).not.toHaveBeenCalled();
      expect(f.messages).toEqual([]);
    } finally {
      f.prepared.resolve();
      await f.host.close();
    }
  });
  it("acknowledges only durable confirmations, deduplicates inflight receipts and suppresses ACKs after reconnect", async () => {
    const f = fixture();
    try {
      f.prepared.resolve();
      f.host.receive({ ...f.receipt, sessionId: randomUUID() }, f.sessionId, f.generation);
      expect(f.persistence.phase4ConfirmEffect).not.toHaveBeenCalled();
      f.host.receive(f.receipt, f.sessionId, f.generation);
      f.host.receive(f.receipt, f.sessionId, f.generation);
      expect(f.persistence.phase4ConfirmEffect).toHaveBeenCalledTimes(1);
      expect(f.messages).toEqual([]);
      f.confirmed.resolve(f.ack);
      await vi.waitFor(() => expect(f.messages).toHaveLength(1));
      expect(f.messages[0]).toMatchObject({ type: "scene.effect.ack", payload: f.ack });
      f.reconnect();
      f.host.receive(f.receipt, f.sessionId, f.generation);
      await Promise.resolve();
      expect(f.messages).toHaveLength(1);
    } finally {
      f.prepared.resolve();
      await f.host.close();
    }
  });
});
