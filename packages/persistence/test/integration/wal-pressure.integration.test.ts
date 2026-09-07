import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createPersistenceClient } from "../../src/index.js";
import { WorkerDatabases } from "../../src/worker/database.js";
import { createTempDataDirectory, cleanupTempDataDirectory, WORKER_FIXTURE } from "../helpers.js";

const highWater = 16 * 1024 ** 2;
it("stops public background writes behind a pinned snapshot, keeps accepted state readable and resumes after checkpoint", async () => {
  const directory = createTempDataDirectory("wal-public-");
  const options = {
    dataDirectory: directory,
    worker: WORKER_FIXTURE,
    diskAdmission: { walHighWaterBytes: highWater },
  };
  let client = createPersistenceClient(options);
  let reader: DatabaseSync | undefined;
  const scope = { scopeKey: "b".repeat(64), providerId: "iris" };
  let revision = 0;
  let accepted = {};
  try {
    await client.migrate();
    reader = new DatabaseSync(join(directory, "state.db"), { readOnly: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM sqlite_schema").get();
    for (let index = 0; index < 256; index++) {
      const state = {
        text: String(index) + String.fromCharCode(65 + (index % 26)).repeat(250_000),
      };
      try {
        revision = await client.phase4WriteProviderState({
          ...scope,
          expectedRevision: revision,
          state,
        });
        accepted = state;
      } catch (error) {
        expect(error).toMatchObject({
          code: "storage_not_ready",
          message: "persistence WAL checkpoint required",
        });
        break;
      }
    }
    expect(revision).toBeGreaterThan(0);
    expect(revision).toBeLessThan(256);
    const frozenSize = statSync(join(directory, "state.db-wal")).size;
    expect(frozenSize).toBeGreaterThanOrEqual(highWater);
    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(
        client.phase4WriteProviderState({
          ...scope,
          expectedRevision: revision,
          state: { rejected: attempt },
        }),
      ).rejects.toMatchObject({ code: "storage_not_ready" });
      expect(await client.phase4ReadProviderState(scope)).toEqual({ revision, state: accepted });
      expect(await client.readDiskStatus()).toMatchObject({
        ready: false,
        reason: "wal_pressure",
        walHighWaterBytes: highWater,
      });
      expect(statSync(join(directory, "state.db-wal")).size).toBe(frozenSize);
    }
    reader.exec("ROLLBACK");
    reader.close();
    reader = undefined;
    expect((await client.readDiskStatus()).ready).toBe(true);
    expect(statSync(join(directory, "state.db-wal")).size).toBe(0);
    expect(await client.phase4ReadProviderState(scope)).toEqual({ revision, state: accepted });
    expect(
      await client.phase4WriteProviderState({
        ...scope,
        expectedRevision: revision,
        state: { resumed: true },
      }),
    ).toBe(revision + 1);
    await client.close();
    client = createPersistenceClient(options);
    await client.migrate();
    expect(await client.phase4ReadProviderState(scope)).toEqual({
      revision: revision + 1,
      state: { resumed: true },
    });
  } finally {
    reader?.close();
    await client.close();
    cleanupTempDataDirectory(directory);
  }
}, 20_000);

it.each(["state", "telemetry"] as const)(
  "fences cached, CTE, RETURNING and exec writes in %s while allowing read transactions and rollback",
  (name) => {
    const directory = createTempDataDirectory(`wal-${name}-`);
    const databases = new WorkerDatabases({
      dataDirectory: directory,
      diskAdmission: { walHighWaterBytes: highWater },
    });
    const db = databases[name];
    let reader: DatabaseSync | undefined;
    try {
      db.exec("CREATE TABLE pressure(id INTEGER PRIMARY KEY, version INTEGER, payload BLOB)");
      db.prepare("INSERT INTO pressure VALUES(1, 0, zeroblob(250000))").run();
      const cached = db.prepare(
        "UPDATE pressure SET version=version+1, payload=randomblob(250000) WHERE id=1",
      );
      const returning = db.prepare(
        "WITH target AS (SELECT 1 AS id) UPDATE pressure SET version=version+1 WHERE id IN (SELECT id FROM target) RETURNING version",
      );
      reader = new DatabaseSync(join(directory, `${name}.db`), { readOnly: true });
      reader.exec("BEGIN");
      reader.prepare("SELECT version FROM pressure").get();
      let accepted = 0;
      for (; accepted < 256; accepted++) {
        try {
          cached.run();
        } catch (error) {
          expect(error).toMatchObject({ code: "storage_not_ready" });
          break;
        }
      }
      expect(accepted).toBeGreaterThan(0);
      expect(accepted).toBeLessThan(256);
      const frozenSize = statSync(join(directory, `${name}.db-wal`)).size;
      expect(frozenSize).toBeGreaterThanOrEqual(highWater);
      for (const attempt of [
        () => cached.run(),
        () => returning.get(),
        () => returning.all(),
        () => db.exec("UPDATE pressure SET version=version+1"),
      ]) {
        expect(attempt).toThrow("persistence WAL checkpoint required");
        expect(statSync(join(directory, `${name}.db-wal`)).size).toBe(frozenSize);
      }
      db.exec("BEGIN");
      expect(db.prepare("SELECT version FROM pressure").get()).toEqual({ version: accepted });
      expect(() => returning.get()).toThrow("persistence WAL checkpoint required");
      db.exec("ROLLBACK");
      expect(() => db.exec("ROLLBACK")).toThrow();
      reader.exec("ROLLBACK");
      reader.close();
      reader = undefined;
      expect(returning.get()).toEqual({ version: accepted + 1 });
      expect(statSync(join(directory, `${name}.db-wal`)).size).toBeLessThan(highWater);
    } finally {
      reader?.close();
      databases.close();
      cleanupTempDataDirectory(directory);
    }
  },
);
