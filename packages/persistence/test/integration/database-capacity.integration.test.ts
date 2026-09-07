import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createPersistenceClient, type PersistenceClient } from "../../src/index.js";
import {
  SESSION_ID,
  TRACE,
  WORKER_FIXTURE,
  makeSessionRecord,
  createTempDataDirectory,
  cleanupTempDataDirectory,
} from "../helpers.js";

it("enforces a SQLite cap on background writes, preserves an auto-rolled-back barrier and reapplies limits on restart", async () => {
  const directory = createTempDataDirectory("database-capacity-");
  const options = {
    dataDirectory: directory,
    worker: WORKER_FIXTURE,
    diskAdmission: { stateMaxBytes: 16 * 1024 ** 2, telemetryMaxBytes: 16 * 1024 ** 2 },
  };
  let client: PersistenceClient = createPersistenceClient(options);
  const scope = { scopeKey: "e".repeat(64), providerId: "iris" };
  const state = { barrier: "keep-original", revision: "1" };
  const accepted: string[] = [];
  let rejectedId = "";
  try {
    await client.migrate();
    await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 0, trace: TRACE });
    expect((await client.readDiskStatus()).capacity?.stateLimitBytes).toBe(16 * 1024 ** 2);
    await client.phase4WriteProviderState({ ...scope, expectedRevision: 0, state });
    // Public append-only writes, no fixture SQL or manual quota/ACK edits.
    for (let index = 0; index < 200; index++) {
      const id = randomUUID();
      try {
        await client.appendRecord({
          record: makeSessionRecord({
            recordId: id,
            aggregateId: id,
            payload: { text: "x".repeat(250_000) },
          }),
          trace: TRACE,
        });
        accepted.push(id);
      } catch (error) {
        expect(error).toMatchObject({
          code: "storage_not_ready",
          retryable: false,
          message: "persistence database capacity exhausted",
        });
        rejectedId = id;
        break;
      }
    }
    expect(accepted.length).toBeGreaterThan(0);
    expect(rejectedId).not.toBe("");
    const status = await client.readDiskStatus();
    expect(status).toMatchObject({ ready: false, reason: "database_limit" });
    expect(status.capacity!.stateAllocatedBytes).toBeLessThanOrEqual(16 * 1024 ** 2);
    // This write owns an explicit transaction. SQLITE_FULL auto-rolls it back;
    // the repository's cleanup must not replace that error with "no transaction".
    await expect(
      client.phase4WriteProviderState({
        ...scope,
        expectedRevision: 1,
        state: { text: "y".repeat(262_100) },
      }),
    ).rejects.toMatchObject({ code: "storage_not_ready" });
    expect(await client.phase4ReadProviderState(scope)).toEqual({ revision: 1, state });
    expect(
      await client.listRecords({
        sessionId: SESSION_ID,
        aggregateId: rejectedId,
        limit: 1,
      }),
    ).toEqual([]);
    await client.close();
    expect(statSync(join(directory, "state.db")).size).toBeLessThanOrEqual(16 * 1024 ** 2);
    client = createPersistenceClient(options);
    await client.migrate();
    expect((await client.readDiskStatus()).capacity!.stateLimitBytes).toBe(16 * 1024 ** 2);
    expect((await client.readDiskStatus()).ready).toBe(false);
    expect(await client.phase4ReadProviderState(scope)).toEqual({ revision: 1, state });
    for (const id of accepted) {
      const rows = await client.listRecords({
        sessionId: SESSION_ID,
        aggregateId: id,
        limit: 1,
      });
      expect(rows[0]?.recordId).toBe(id);
    }
    await client.close();
    client = createPersistenceClient({
      ...options,
      diskAdmission: { ...options.diskAdmission, stateMaxBytes: 32 * 1024 ** 2 },
    });
    await client.migrate();
    expect(
      await client.phase4WriteProviderState({
        ...scope,
        expectedRevision: 1,
        state: { text: "y".repeat(262_100) },
      }),
    ).toBe(2);
    await client.close();
    client = createPersistenceClient(options);
    await expect(client.migrate()).rejects.toMatchObject({ code: "unavailable" });
    await client.close();
    // Refusing the smaller quota must release every DB/lock handle.
    client = createPersistenceClient({
      ...options,
      diskAdmission: { stateMaxBytes: 32 * 1024 ** 2 },
    });
    await client.migrate();
    expect((await client.phase4ReadProviderState(scope))?.revision).toBe(2);
  } finally {
    await client.close();
    cleanupTempDataDirectory(directory);
  }
}, 20_000);

it("limits telemetry allocations and releases both database handles when a smaller restart budget is refused", async () => {
  const { createPersistenceClientForTesting } =
    await import("../../src/client/persistence-client.js");
  const { TELEMETRY_MIGRATIONS } = await import("../../src/migrations/registry.js");
  const directory = createTempDataDirectory("telemetry-capacity-");
  const options = {
    dataDirectory: directory,
    worker: WORKER_FIXTURE,
    diskAdmission: { telemetryMaxBytes: 16 * 1024 ** 2 },
  };
  const overrides = {
    migrations: {
      telemetry: [
        ...TELEMETRY_MIGRATIONS,
        {
          version: 2,
          name: "capacity-fixture",
          sql: "CREATE TABLE capacity_fixture(payload BLOB); INSERT INTO capacity_fixture VALUES(zeroblob(33554432));",
        },
      ],
    },
  };
  let client = createPersistenceClientForTesting(options, overrides);
  try {
    await expect(client.migrate()).rejects.toMatchObject({ code: "storage_not_ready" });
    await client.close();
    expect(statSync(join(directory, "telemetry.db")).size).toBeLessThanOrEqual(16 * 1024 ** 2);
    client = createPersistenceClientForTesting(
      {
        ...options,
        diskAdmission: {
          telemetryMaxBytes: 64 * 1024 ** 2,
          transactionCacheMaxBytes: 64 * 1024 ** 2,
        },
      },
      overrides,
    );
    await client.migrate();
    const capacity = (await client.readDiskStatus()).capacity!;
    expect(capacity.telemetryAllocatedBytes).toBeGreaterThan(32 * 1024 ** 2);
    expect(capacity.telemetryAllocatedBytes).toBeLessThanOrEqual(64 * 1024 ** 2);
    await client.close();
    client = createPersistenceClientForTesting(options, overrides);
    await expect(client.migrate()).rejects.toMatchObject({ code: "unavailable" });
    await client.close();
    client = createPersistenceClientForTesting(
      {
        ...options,
        diskAdmission: {
          telemetryMaxBytes: 64 * 1024 ** 2,
          transactionCacheMaxBytes: 64 * 1024 ** 2,
        },
      },
      overrides,
    );
    await client.migrate();
    expect((await client.readDiskStatus()).capacity!.telemetryLimitBytes).toBe(64 * 1024 ** 2);
  } finally {
    await client.close();
    cleanupTempDataDirectory(directory);
  }
});
