import { statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WorkerDatabases } from "../../src/worker/database.js";
import { createTempDataDirectory, cleanupTempDataDirectory } from "../helpers.js";

it.each(["state", "telemetry"] as const)(
  "bounds %s WAL for repeated updates inside one transaction and rejects oversized commits atomically",
  (name) => {
    const directory = createTempDataDirectory(`transaction-capacity-${name}-`);
    const options = {
      dataDirectory: directory,
      diskAdmission: { transactionCacheMaxBytes: 4 * 1024 ** 2 },
    };
    let databases = new WorkerDatabases(options);
    try {
      let db = databases[name];
      db.exec("CREATE TABLE capacity(id INTEGER PRIMARY KEY, version INTEGER, payload BLOB)");
      db.prepare("INSERT INTO capacity VALUES(1, 0, zeroblob(1000000))").run();
      const before = statSync(join(directory, `${name}.db-wal`)).size;
      db.exec("BEGIN IMMEDIATE");
      const update = db.prepare(
        "UPDATE capacity SET version=version+1, payload=randomblob(1000000) WHERE id=1",
      );
      // About 100 MiB of logical writes to the same pages must not spill into
      // an unbounded WAL during a single admitted transaction.
      for (let i = 0; i < 100; i++) update.run();
      expect(statSync(join(directory, `${name}.db-wal`)).size).toBe(before);
      db.exec("COMMIT");
      expect(db.prepare("SELECT version FROM capacity").get()).toEqual({ version: 100 });
      expect(statSync(join(directory, `${name}.db-wal`)).size - before).toBeLessThan(
        4.2 * 1024 ** 2,
      );
      const acceptedSize = statSync(join(directory, `${name}.db-wal`)).size;
      for (const sql of [
        "INSERT INTO capacity VALUES(2, 0, zeroblob(12000000))",
        "BEGIN; UPDATE capacity SET version=999; INSERT INTO capacity VALUES(2, 0, zeroblob(12000000)); COMMIT",
        "SAVEPOINT nested; UPDATE capacity SET version=999; INSERT INTO capacity VALUES(2, 0, zeroblob(12000000)); RELEASE nested",
      ]) {
        expect(() => db.exec(sql)).toThrow("persistence transaction capacity exhausted");
        db.exec("ROLLBACK"); // Native guard has already rolled back the transaction.
        expect(db.prepare("SELECT id, version FROM capacity").all()).toEqual([
          { id: 1, version: 100 },
        ]);
        expect(statSync(join(directory, `${name}.db-wal`)).size).toBe(acceptedSize);
      }
      let interrupted: unknown;
      try {
        db.exec(
          "BEGIN; WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<20) INSERT INTO capacity SELECT x+1, 0, randomblob(1000000) FROM n; COMMIT",
        );
      } catch (error) {
        interrupted = error;
      }
      expect(interrupted).toMatchObject({ code: "storage_not_ready", cause: { errcode: 9 } });
      expect(db.prepare("SELECT id, version FROM capacity").all()).toEqual([
        { id: 1, version: 100 },
      ]);
      expect(statSync(join(directory, `${name}.db-wal`)).size).toBe(acceptedSize);
      const returning = db.prepare(
        "INSERT INTO capacity VALUES(2, 0, zeroblob(12000000)) RETURNING id",
      );
      for (const method of ["run", "get", "all"] as const) {
        expect(() => returning[method]()).toThrow("persistence transaction capacity exhausted");
        expect(db.prepare("SELECT id, version FROM capacity").all()).toEqual([
          { id: 1, version: 100 },
        ]);
        expect(statSync(join(directory, `${name}.db-wal`)).size).toBe(acceptedSize);
      }
      for (const sql of [
        "PRAGMA cache_spill=ON",
        "PRAGMA max_page_count=999999",
        "SELECT bellis_guard(67108864)",
        "ATTACH ':memory:' AS bypass",
      ])
        expect(() => db.prepare(sql).get()).toThrow("storage settings are owned by the Worker");
      db.prepare("UPDATE capacity SET version=101").run();
      expect(databases.diskAdmission.read().transactionCacheMaxBytes).toBe(4 * 1024 ** 2);
      databases.close();
      databases = new WorkerDatabases(options);
      db = databases[name];
      expect(db.prepare("SELECT id, version FROM capacity").all()).toEqual([
        { id: 1, version: 101 },
      ]);
      expect(() =>
        db.prepare("INSERT INTO capacity VALUES(2, 0, zeroblob(12000000))").run(),
      ).toThrow("persistence transaction capacity exhausted");
    } finally {
      databases.close();
      cleanupTempDataDirectory(directory);
    }
  },
);

it("keeps native cache budgets independent across connections", () => {
  const smallDir = createTempDataDirectory("guard-small-");
  const largeDir = createTempDataDirectory("guard-large-");
  const small = new WorkerDatabases({
    dataDirectory: smallDir,
    diskAdmission: { transactionCacheMaxBytes: 4 * 1024 ** 2 },
  });
  const large = new WorkerDatabases({
    dataDirectory: largeDir,
    diskAdmission: { transactionCacheMaxBytes: 16 * 1024 ** 2 },
  });
  try {
    for (const db of [small.state, large.state]) db.exec("CREATE TABLE t(data BLOB)");
    const sql = "INSERT INTO t VALUES(zeroblob(6000000))";
    expect(() => small.state.exec(sql)).toThrow("persistence transaction capacity exhausted");
    large.state.exec(sql);
    expect(large.state.prepare("SELECT length(data) AS bytes FROM t").get()).toEqual({
      bytes: 6_000_000,
    });
    expect(small.state.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 0 });
    expect(() => small.state.exec(sql)).toThrow("persistence transaction capacity exhausted");
  } finally {
    small.close();
    large.close();
    cleanupTempDataDirectory(smallDir);
    cleanupTempDataDirectory(largeDir);
  }
});
