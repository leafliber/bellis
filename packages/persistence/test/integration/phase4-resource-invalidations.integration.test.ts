import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { MemoryResourceInvalidation } from "@bellis/contracts";
import { createPersistenceClient } from "../../src/index.js";
import { WORKER_FIXTURE, createTempDataDirectory, cleanupTempDataDirectory } from "../helpers.js";
const scopeKey = "d".repeat(64);
const event = (): MemoryResourceInvalidation => ({
  schemaVersion: 1,
  providerId: "iris",
  agentId: "agent",
  eventId: "delete:one",
  cursor: "7",
  resources: [{ resourceRef: "iris:claim:one", throughRevision: null }],
});

it("atomically deduplicates external invalidation across restart without releasing a newer barrier", async () => {
  const dataDirectory = createTempDataDirectory("resource-event-");
  let client = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
  try {
    await client.migrate();
    await client.phase4EnsureMemoryPolicy(scopeKey, "1");
    const first = await client.phase4ApplyResourceInvalidation(scopeKey, event());
    expect(first).toMatchObject({
      generation: 1,
      blocked: false,
      tombstones: [{ providerId: "iris", resourceRef: "iris:claim:one", throughRevision: null }],
    });
    await client.close();
    client = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
    await client.migrate();
    expect(await client.phase4ApplyResourceInvalidation(scopeKey, event())).toEqual(first);
    await client.phase4ChangeMemoryPolicy({
      scopeKey,
      expectedGeneration: 1,
      changeId: randomUUID(),
      privacyRevision: "2",
      blocked: true,
      reason: "privacy",
      tombstones: [],
    });
    expect(await client.phase4ApplyResourceInvalidation(scopeKey, event())).toMatchObject({
      generation: 2,
      privacyRevision: "2",
      blocked: true,
    });
    await expect(
      client.phase4ApplyResourceInvalidation(scopeKey, {
        ...event(),
        resources: [{ resourceRef: "iris:claim:different", throughRevision: null }],
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(
      await client.phase4ApplyResourceInvalidation(scopeKey, {
        ...event(),
        eventId: "delete:two",
        cursor: "8",
        resources: [{ resourceRef: "iris:claim:two", throughRevision: "4" }],
      }),
    ).toMatchObject({ generation: 3, privacyRevision: "2", blocked: true });
  } finally {
    await client.close();
    cleanupTempDataDirectory(dataDirectory);
  }
});

it("rolls back policy and tombstones if the external event receipt cannot be stored", async () => {
  const dataDirectory = createTempDataDirectory("resource-event-rollback-");
  const client = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
  let fault: DatabaseSync | undefined;
  try {
    await client.migrate();
    await client.phase4EnsureMemoryPolicy(scopeKey, "1");
    fault = new DatabaseSync(join(dataDirectory, "state.db"));
    fault.exec(
      "CREATE TRIGGER fail_resource_receipt BEFORE INSERT ON phase4_resource_invalidations BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    await expect(client.phase4ApplyResourceInvalidation(scopeKey, event())).rejects.toBeDefined();
    expect(await client.phase4ReadMemoryPolicy(scopeKey)).toMatchObject({
      generation: 0,
      tombstones: [],
      blocked: false,
    });
    fault.exec("DROP TRIGGER fail_resource_receipt");
    expect((await client.phase4ApplyResourceInvalidation(scopeKey, event())).generation).toBe(1);
  } finally {
    fault?.close();
    await client.close();
    cleanupTempDataDirectory(dataDirectory);
  }
});
