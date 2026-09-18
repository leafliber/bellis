import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const script = fileURLToPath(import.meta.url);
if (process.argv[2] === "worker") {
  const db = new Database(process.argv[3]);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  const stage = process.argv[4];
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO state VALUES (?, ?)").run("operation", "confirmed");
  if (stage !== "between_state_and_outbox") {
    db.prepare("INSERT INTO outbox VALUES (?, ?)").run("operation", "fact");
  }
  if (stage === "after_commit") db.exec("COMMIT");
  process.send({ stage, committed: stage === "after_commit" });
  // Parent kills this process at the precise crash boundary, without close().
  setInterval(() => {}, 1000);
} else {
  const folder = mkdtempSync(join(tmpdir(), "bellis-sqlite-"));
  const results = [];
  for (const stage of ["between_state_and_outbox", "before_commit", "after_commit"]) {
    for (let iteration = 0; iteration < 10; iteration++) {
      const path = join(folder, `${stage}-${iteration}.sqlite`);
      const setup = new Database(path);
      setup.pragma("journal_mode = WAL");
      setup.pragma("synchronous = FULL");
      setup.exec(
        "CREATE TABLE state (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      setup.close();
      await new Promise((resolve, reject) => {
        const child = fork(script, ["worker", path, stage], {
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        let ready = false;
        let error = "";
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("worker timeout"));
        }, 10000);
        child.stderr.on("data", (chunk) => {
          error += chunk;
        });
        child.on("error", reject);
        child.on("message", () => {
          ready = true;
          child.kill("SIGKILL");
        });
        child.on("exit", (_code, signal) => {
          clearTimeout(timeout);
          if (!ready || signal !== "SIGKILL") reject(new Error(error || "unexpected worker exit"));
          else resolve();
        });
      });
      const recovered = new Database(path);
      const state = recovered.prepare("SELECT count(*) AS n FROM state").get().n;
      const outbox = recovered.prepare("SELECT count(*) AS n FROM outbox").get().n;
      assert.equal(recovered.pragma("integrity_check", { simple: true }), "ok");
      assert.equal(state, stage === "after_commit" ? 1 : 0);
      assert.equal(outbox, state);
      recovered.close();
      results.push({ stage, iteration, state, outbox, status: "PASS" });
    }
  }
  const full = new Database(join(folder, "page-limit.sqlite"));
  full.pragma("journal_mode = WAL");
  full.pragma("synchronous = FULL");
  full.exec(
    "CREATE TABLE state (id TEXT PRIMARY KEY); CREATE TABLE outbox (id TEXT PRIMARY KEY, payload BLOB)",
  );
  full.pragma("max_page_count = 8");
  assert.throws(
    () =>
      full.transaction(() => {
        full.prepare("INSERT INTO state VALUES (?)").run("operation");
        full
          .prepare("INSERT INTO outbox VALUES (?, ?)")
          .run("operation", Buffer.alloc(1024 * 1024));
      })(),
    { code: "SQLITE_FULL" },
  );
  assert.equal(full.prepare("SELECT count(*) AS n FROM state").get().n, 0);
  assert.equal(full.prepare("SELECT count(*) AS n FROM outbox").get().n, 0);
  assert.equal(full.pragma("integrity_check", { simple: true }), "ok");
  full.close();
  results.push({
    stage: "SQLITE_FULL_page_limit",
    iteration: 0,
    state: 0,
    outbox: 0,
    status: "PASS",
  });
  const report = {
    probe: "S-4",
    status: "PARTIAL",
    executed_at: new Date().toISOString(),
    environment: {
      node: process.version,
      os: `${platform()} ${release()}`,
      better_sqlite3: JSON.parse(
        readFileSync(new URL("../../node_modules/better-sqlite3/package.json", import.meta.url)),
      ).version,
    },
    command: "pnpm spike:sqlite",
    source_sha256: createHash("sha256").update(readFileSync(script)).digest("hex"),
    scope: "Local WAL/FULL state+outbox transaction recovery across SIGKILL",
    not_tested: [
      "power loss",
      "fsync failure",
      "physical disk exhaustion (SQLITE_FULL was injected with max_page_count)",
      "Windows filesystem",
      "production SUT",
      "remote effect delivery",
    ],
    database_directory: folder,
    results,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/spike-sqlite.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      probe: report.probe,
      status: report.status,
      passed: results.length,
      report: "reports/spike-sqlite.json",
    }),
  );
}
