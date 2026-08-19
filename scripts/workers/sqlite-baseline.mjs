/**
 * SQLite 基线冒烟 Worker（由 scripts/verify-runtime-baseline.mjs 以短生命周期
 * Worker 启动）。node:sqlite 只允许在该隔离文件中导入；结果通过
 * parentPort 回报，stderr 由父进程捕获并作为失败依据。
 */
import { parentPort } from "node:worker_threads";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const tempDir = mkdtempSync(join(tmpdir(), "bellis-sqlite-baseline-"));
const dbPath = join(tempDir, "state.db");

const result = {
  node: process.versions.node,
  sqlite: process.versions.sqlite ?? null,
  platform: `${process.platform}/${process.arch}`,
  checks: [],
};

function check(name, fn) {
  try {
    fn();
    result.checks.push({ name, ok: true });
  } catch (error) {
    result.checks.push({ name, ok: false, error: String(error) });
  }
}

try {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 3000;");

  check("wal-mode", () => {
    const row = db.prepare("PRAGMA journal_mode").get();
    const mode = String(row?.journal_mode ?? "").toLowerCase();
    if (mode !== "wal") {
      throw new Error(`journal_mode=${mode}`);
    }
  });

  check("transaction-commit", () => {
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, value BIGINT)");
    db.exec("BEGIN IMMEDIATE");
    // 2^53+1：超过 JSON 安全整数，验证 BigInt 无损存取。
    db.prepare("INSERT INTO t (id, value) VALUES (?, ?)").run(1, 9007199254740993n);
    db.exec("COMMIT");
  });

  check("bigint-read", () => {
    const statement = db.prepare("SELECT value FROM t WHERE id = 1");
    statement.setReadBigInts(true);
    const row = statement.get();
    if (row?.value !== 9007199254740993n) {
      throw new Error(`value=${String(row?.value)}`);
    }
  });

  check("transaction-rollback", () => {
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO t (id, value) VALUES (?, ?)").run(2, 1n);
    db.exec("ROLLBACK");
    const row = db.prepare("SELECT COUNT(*) AS n FROM t WHERE id = 2").get();
    if (Number(row?.n ?? 0) !== 0) {
      throw new Error("rolled-back row still visible");
    }
  });

  db.close();

  check("reopen-persistent", () => {
    const reopened = new DatabaseSync(dbPath);
    const statement = reopened.prepare("SELECT value FROM t WHERE id = 1");
    statement.setReadBigInts(true);
    const row = statement.get();
    reopened.close();
    if (row?.value !== 9007199254740993n) {
      throw new Error(`value=${String(row?.value)}`);
    }
  });
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

parentPort?.postMessage(result);
if (result.checks.some((entry) => !entry.ok)) {
  process.exitCode = 1;
}
