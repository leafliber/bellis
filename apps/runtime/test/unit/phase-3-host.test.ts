import { describe, expect, it, vi } from "vitest";
import type { PersistenceClient } from "@bellis/persistence";
import { VirtualClock } from "@bellis/testkit";
import { Phase3DecisionHost } from "../../src/application/phase-3/host.js";
import { DemoScriptedProvider } from "../../src/providers/model/demo-scripted.js";

describe("Phase3 host composition", () => {
  it("refuses to rebind while an input append is pending, preserving its original Session", async () => {
    const clock = new VirtualClock();
    let release!: () => void;
    const appended = new Promise<void>((resolve) => {
      release = resolve;
    });
    const append = vi.fn(async () => {
      await appended;
      return { result: "accepted" as const, sequence: 1n };
    });
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const host = new Phase3DecisionHost({
      sessionId,
      clock,
      wallClockMs: () => 0,
      persistence: { phase3AppendSignal: append } as unknown as PersistenceClient,
      provider: new DemoScriptedProvider({ clock }),
      model: "fixture",
      instructions: "fixture",
    });
    try {
      const pending = host.ingest({
        schemaVersion: 1,
        id: "22222222-2222-4222-8222-222222222222",
        kind: "danmaku",
        source: "fixture",
        occurredAt: 0,
        priority: 100,
        payload: { userId: "u", text: "pending" },
      });
      expect(() => host.bindSessionId("33333333-3333-4333-8333-333333333333")).toThrow(
        "already owns work",
      );
      release();
      expect(await pending).toMatchObject({ result: "accepted" });
      expect(append).toHaveBeenCalledWith(expect.objectContaining({ sessionId }));
    } finally {
      release();
      await host.close();
    }
  });

  it.each([0, 2])(
    "keeps an empty tool catalog and bounds optional evidence at %i",
    async (capacity) => {
      const clock = new VirtualClock();
      const host = new Phase3DecisionHost({
        sessionId: "11111111-1111-4111-8111-111111111111",
        clock,
        wallClockMs: () => 0,
        // Invalid input never reaches persistence; this also verifies no demo side effect at construction.
        persistence: {} as PersistenceClient,
        provider: new DemoScriptedProvider({ clock }),
        model: "fixture",
        instructions: "fixture",
        ...(capacity === 0 ? {} : { evidenceCapacity: capacity }),
      });
      expect(host.toolRuntime.listDeclarations()).toEqual([]);
      for (let i = 0; i < 20; i += 1) await host.ingest({ invalid: i });
      expect(host.evidence().ingest).toHaveLength(capacity);
      expect(host.evidence().toolRuns).toEqual([]);
      await host.close();
      expect(clock.pendingCount()).toBe(0);
    },
  );
});
