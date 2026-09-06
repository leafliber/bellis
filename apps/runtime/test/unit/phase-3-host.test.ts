import { describe, expect, it } from "vitest";
import type { PersistenceClient } from "@bellis/persistence";
import { VirtualClock } from "@bellis/testkit";
import { Phase3DecisionHost } from "../../src/application/phase-3/host.js";
import { DemoScriptedProvider } from "../../src/providers/model/demo-scripted.js";

describe("Phase3 host composition", () => {
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
