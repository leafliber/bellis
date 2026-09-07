import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { context } from "../phase4-fixtures.js";
import { createPersistenceClient } from "../../src/index.js";
import {
  SESSION_ID,
  TRACE,
  WORKER_FIXTURE,
  cleanupTempDataDirectory,
  createTempDataDirectory,
} from "../helpers.js";

describe("Phase 4 context adoption through DB Worker", () => {
  it("atomically adopts Manifest/Usage, deduplicates adoption, and restores immutable audit after restart", async () => {
    const directory = createTempDataDirectory("phase4-context");
    let client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
    try {
      await client.migrate();
      await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 1, trace: TRACE });
      const cycleId = randomUUID();
      const adopted = context(cycleId);
      const input = {
        sessionId: SESSION_ID,
        cycleId,
        turnId: randomUUID(),
        batchId: randomUUID(),
        cycleIndex: 0,
        watermarkFrom: 1n,
        watermarkTo: 1n,
        next: "finish" as const,
        degraded: false,
        packetDigest: "d".repeat(64),
        toolRuns: [],
        context: adopted,
        trace: TRACE,
      };
      await client.phase3AdoptCycle(input);
      await client.phase3AdoptCycle(input);
      await expect(
        client.phase3AdoptCycle({ ...input, context: { ...adopted, usage: [] } }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      await expect(
        client.phase3AdoptCycle({ ...input, packetDigest: "e".repeat(64) }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      expect((await client.phase3ReadDecisionState(SESSION_ID)).consumed).toBe(1n);
      expect(await client.phase4ReadContextManifest(SESSION_ID, cycleId)).toEqual({
        manifest: adopted.manifest,
        manifestDigest: adopted.manifestDigest,
      });
      expect(await client.phase4ReadContextManifest(randomUUID(), cycleId)).toBeNull();
      expect((await client.readOutboxStats()).pending).toBe(1);
      await client.close();
      client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
      await client.migrate();
      expect(await client.phase4ReadContextManifest(SESSION_ID, cycleId)).toEqual({
        manifest: adopted.manifest,
        manifestDigest: adopted.manifestDigest,
      });
      const messages = await client.claimOutbox({
        limit: 8,
        leaseMs: 1000,
        ownerInstanceId: "phase4-restart",
      });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        topic: "memory.usage.v1",
        payload: { report: adopted.usage[0]!.report },
      });
    } finally {
      await client.close();
      cleanupTempDataDirectory(directory);
    }
  });

  it("rolls back cycle, watermark, Manifest and Usage on digest/lineage/outbox validation failures", async () => {
    const directory = createTempDataDirectory("phase4-rollback");
    const client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
    try {
      await client.migrate();
      await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 1, trace: TRACE });
      for (const failure of ["digest", "lineage", "outbox"]) {
        const cycleId = randomUUID();
        const adopted = context(cycleId);
        if (failure === "digest") adopted.manifestDigest = "f".repeat(64);
        if (failure === "lineage") adopted.usage[0]!.report.personaRevision = "2";
        if (failure === "outbox") adopted.usage[0]!.report.outboxId = "not-a-uuid";
        await expect(
          client.phase3AdoptCycle({
            sessionId: SESSION_ID,
            cycleId,
            turnId: randomUUID(),
            batchId: randomUUID(),
            cycleIndex: 0,
            watermarkFrom: 1n,
            watermarkTo: 1n,
            next: "finish",
            degraded: false,
            packetDigest: "d".repeat(64),
            toolRuns: [],
            context: adopted,
            trace: TRACE,
          }),
        ).rejects.toBeDefined();
        expect(await client.phase4ReadContextManifest(SESSION_ID, cycleId)).toBeNull();
        expect((await client.phase3ReadDecisionState(SESSION_ID)).consumed).toBe(0n);
        expect((await client.readOutboxStats()).pending).toBe(0);
      }
    } finally {
      await client.close();
      cleanupTempDataDirectory(directory);
    }
  });
});
