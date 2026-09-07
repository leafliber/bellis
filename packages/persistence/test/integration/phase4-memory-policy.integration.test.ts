import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ContextManifestSchema, type MemoryPolicyStamp } from "@bellis/contracts";
import { createPersistenceClient } from "../../src/index.js";
import { context } from "../phase4-fixtures.js";
import {
  SESSION_ID,
  TRACE,
  WORKER_FIXTURE,
  createTempDataDirectory,
  cleanupTempDataDirectory,
} from "../helpers.js";

const scopeKey = "d".repeat(64);
function adoption(policy?: MemoryPolicyStamp, resourceRevision?: string) {
  const cycleId = randomUUID();
  const value = context(cycleId);
  value.manifest = ContextManifestSchema.parse({
    ...value.manifest,
    ...(policy === undefined ? {} : { policy }),
    blocks:
      resourceRevision === undefined
        ? []
        : [
            {
              providerId: "iris",
              blockId: "one",
              revision: resourceRevision,
              contentHash: "a".repeat(64),
              textHash: "b".repeat(64),
              normalizedHash: "c".repeat(64),
              sourceHashScheme: "iris-canonical-v1",
              sourceHashVerification: "passthrough",
              privacyScope: "space:one",
              sourceRefs: [`iris:claim:one@${resourceRevision}`],
              result: "included",
            },
          ],
  });
  value.manifestDigest = createHash("sha256").update(JSON.stringify(value.manifest)).digest("hex");
  return {
    sessionId: SESSION_ID,
    cycleId,
    turnId: randomUUID(),
    batchId: randomUUID(),
    cycleIndex: 0,
    watermarkFrom: 1n,
    watermarkTo: 1n,
    next: "finish" as const,
    degraded: false,
    packetDigest: "a".repeat(64),
    toolRuns: [],
    context: value,
    trace: TRACE,
  };
}

describe("Phase 4 durable privacy policy", () => {
  it("rechecks adoption generation and tombstones in the transaction, without advancing consumption or usage on rejection", async () => {
    const directory = createTempDataDirectory("phase4-policy-adoption");
    const client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
    try {
      await client.migrate();
      await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 0, trace: TRACE });
      await client.phase4EnsureMemoryPolicy(scopeKey, "1");
      const stale = adoption({ scopeKey, generation: 0 });
      await client.phase4ChangeMemoryPolicy({
        scopeKey,
        expectedGeneration: 0,
        changeId: randomUUID(),
        privacyRevision: "1",
        blocked: false,
        reason: "resource-invalidated",
        tombstones: [{ providerId: "iris", resourceRef: "iris:claim:one", throughRevision: "2" }],
      });
      for (const rejected of [stale, adoption({ scopeKey, generation: 1 }, "2")]) {
        await expect(client.phase3AdoptCycle(rejected)).rejects.toMatchObject({
          code: "invalid_request",
        });
        expect(await client.phase4ReadContextManifest(SESSION_ID, rejected.cycleId)).toBeNull();
      }
      expect((await client.phase3ReadDecisionState(SESSION_ID)).consumed).toBe(0n);
      expect((await client.readOutboxStats()).pending).toBe(0);
      const accepted = adoption({ scopeKey, generation: 1 }, "3");
      await client.phase3AdoptCycle(accepted);
      expect((await client.readOutboxStats()).pending).toBe(1);
      const otherScope = "f".repeat(64);
      await client.phase4EnsureMemoryPolicy(otherScope, "1");
      await expect(
        client.phase3AdoptCycle(adoption({ scopeKey: otherScope, generation: 0 })),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect((await client.readOutboxStats()).pending).toBe(1);
      await expect(client.phase3AdoptCycle(adoption())).rejects.toMatchObject({
        code: "invalid_request",
      });
      const change = {
        scopeKey,
        expectedGeneration: 1,
        changeId: randomUUID(),
        privacyRevision: "1",
        blocked: true,
        reason: "forget" as const,
        tombstones: [{ providerId: "iris", resourceRef: "iris:claim:one", throughRevision: null }],
      };
      await client.phase4ChangeMemoryPolicy(change);
      expect(
        await client.claimOutbox({ limit: 10, leaseMs: 1000, ownerInstanceId: "privacy" }),
      ).toEqual([]);
      // Replaying an already adopted fact does not re-create its suppressed Usage.
      await client.phase3AdoptCycle(accepted);
      expect((await client.readOutboxStats()).pending).toBe(0);
      await expect(
        client.phase3AdoptCycle(adoption({ scopeKey, generation: 2 }, "4")),
      ).rejects.toMatchObject({ code: "invalid_request" });
      await expect(
        client.phase4ChangeMemoryPolicy({ ...change, blocked: false }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      await client.phase4ChangeMemoryPolicy({
        ...change,
        changeId: randomUUID(),
        expectedGeneration: 2,
        blocked: false,
        tombstones: [{ providerId: "iris", resourceRef: "iris:claim:one", throughRevision: "1" }],
      });
      expect(
        (await client.phase4ReadMemoryPolicy(scopeKey)).tombstones[0]?.throughRevision,
      ).toBeNull();
      await expect(
        client.phase3AdoptCycle(adoption({ scopeKey, generation: 3 }, "99")),
      ).rejects.toMatchObject({ code: "invalid_request" });
    } finally {
      await client.close();
      cleanupTempDataDirectory(directory);
    }
  });
});
