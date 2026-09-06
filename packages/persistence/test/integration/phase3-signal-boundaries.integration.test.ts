import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPersistenceClientForTesting } from "../../src/client/persistence-client.js";
import { STATE_MIGRATIONS } from "../../src/migrations/registry.js";
import {
  TRACE,
  WORKER_FIXTURE,
  createTempDataDirectory,
  cleanupTempDataDirectory,
} from "../helpers.js";

const makeSignal = (source = "platform-a") => ({
  schemaVersion: 1 as const,
  id: randomUUID(),
  source,
  kind: "danmaku",
  occurredAt: 1,
  priority: 100,
  payload: { text: "hello" },
});

describe("Phase 3 durable signal boundaries", () => {
  it.each([9n, 10n, 9007199254740992n, 9223372036854775808n])(
    "counts, restores and assigns exactly above watermark %s",
    async (watermark) => {
      const dataDirectory = createTempDataDirectory("phase3-boundary-");
      const sessionId = randomUUID();
      const client = createPersistenceClientForTesting({ dataDirectory, worker: WORKER_FIXTURE });
      try {
        await client.migrate();
        const db = new DatabaseSync(join(dataDirectory, "state.db"));
        try {
          db.prepare("INSERT INTO phase3_decision_state VALUES (?, ?, 1)").run(
            sessionId,
            String(watermark),
          );
          for (const sequence of [watermark - 1n, watermark, watermark + 1n, watermark + 2n]) {
            const signal = makeSignal();
            db.prepare("INSERT INTO phase3_signals VALUES (?, ?, ?, 'normal', 1, ?)").run(
              sessionId,
              String(sequence),
              signal.id,
              JSON.stringify(signal),
            );
          }
        } finally {
          db.close();
        }
        const restored = await client.phase3RestoreSignals(sessionId);
        expect(restored.lastAssigned).toBe(watermark + 2n);
        expect(restored.pending.map((entry) => entry.sequence)).toEqual([
          String(watermark + 1n),
          String(watermark + 2n),
        ]);
        const input = {
          sessionId,
          signal: makeSignal(),
          priorityClass: "normal" as const,
          receivedAtMs: 1,
          normalCapacity: 2,
          urgentCapacity: 1,
          trace: TRACE,
        };
        expect(await client.phase3AppendSignal(input)).toEqual({
          result: "rejected",
          reason: "normal_capacity",
        });
        expect(await client.phase3AppendSignal({ ...input, priorityClass: "urgent" })).toEqual({
          result: "accepted",
          sequence: watermark + 3n,
        });
        expect(
          await client.phase3AppendSignal({ ...input, normalCapacity: 3, signal: makeSignal() }),
        ).toEqual({ result: "accepted", sequence: watermark + 4n });
      } finally {
        await client.close();
        cleanupTempDataDirectory(dataDirectory);
      }
    },
  );

  it("upgrades existing rows without changing IDs and deduplicates within each source", async () => {
    const dataDirectory = createTempDataDirectory("phase3-source-upgrade-");
    const sessionId = randomUUID();
    const signal = makeSignal();
    const options = { dataDirectory, worker: WORKER_FIXTURE };
    const input = {
      sessionId,
      signal,
      priorityClass: "normal" as const,
      receivedAtMs: 1,
      normalCapacity: 10,
      urgentCapacity: 1,
      trace: TRACE,
    };
    const legacy = createPersistenceClientForTesting(options, {
      migrations: { state: STATE_MIGRATIONS.slice(0, 4) },
    });
    try {
      await legacy.migrate();
      const db = new DatabaseSync(join(dataDirectory, "state.db"));
      try {
        db.prepare("INSERT INTO phase3_signals VALUES (?, '1', ?, 'normal', 1, ?)").run(
          sessionId,
          signal.id,
          JSON.stringify(signal),
        );
      } finally {
        db.close();
      }
    } finally {
      await legacy.close();
    }
    const current = createPersistenceClientForTesting(options);
    try {
      await current.migrate();
      expect(await current.phase3AppendSignal(input)).toEqual({
        result: "deduplicated",
        sequence: 1n,
      });
      const other = { ...input, signal: { ...signal, source: "platform-b" } };
      expect(await current.phase3AppendSignal(other)).toEqual({ result: "accepted", sequence: 2n });
      expect(await current.phase3AppendSignal(other)).toEqual({
        result: "deduplicated",
        sequence: 2n,
      });
      expect(
        (await current.phase3RestoreSignals(sessionId)).pending.map((entry) => entry.signal.source),
      ).toEqual(["platform-a", "platform-b"]);
    } finally {
      await current.close();
      cleanupTempDataDirectory(dataDirectory);
    }
  });
});
