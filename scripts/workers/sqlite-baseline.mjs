/**
 * SQLite 基线冒烟 Worker（由 scripts/verify-runtime-baseline.mjs 以短生命周期
 * Worker 启动）。node:sqlite 只允许在该隔离文件中导入；结果通过
 * parentPort 回报，stderr 由父进程捕获并作为失败依据。
 *
 * 三个模式（workerData.mode）：
 * - baseline：常规校验（WAL、事务提交/回滚、BigInt 读写、关闭重开）。
 *   数据库位于 Worker 自建的临时目录，结束时自清理。
 * - crash-pre-commit：提交一行后开启事务写入第二行，在 COMMIT 之前于
 *   检查点处无限阻塞，等待父进程强制终止（模拟事务中途被杀）。
 *   数据库位于自建临时目录，通过 workerData.dbPath 上报给父进程复用。
 * - verify-recovery：打开父进程传入的 workerData.dbPath（崩溃 Worker
 *   的数据库），验证已提交行存在、未提交行回滚、WAL 保持、
 *   integrity_check 通过。清理由父进程负责。
 */
import { parentPort, workerData } from "node:worker_threads";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const mode = workerData?.mode ?? "baseline";
const inheritedDbPath = typeof workerData?.dbPath === "string" ? workerData.dbPath : null;

function openDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 3000;");
  return db;
}

function readBigIntRow(db, id) {
  const statement = db.prepare("SELECT value FROM t WHERE id = ?");
  statement.setReadBigInts(true);
  return statement.get(id);
}

function blockForever() {
  // 阻塞 Worker 线程模拟崩溃现场：没有定时器、没有可清理资源，
  // 父进程 terminate() 即为强制终止。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

const ownTempDir = mode === "verify-recovery" ? null : mkdtempSync(join(tmpdir(), `bellis-sqlite-${mode}-`));

function report(checks) {
  const result = {
    mode,
    node: process.versions.node,
    sqlite: process.versions.sqlite ?? null,
    platform: `${process.platform}/${process.arch}`,
    checks,
  };
  parentPort?.postMessage(result);
  if (checks.some((entry) => !entry.ok)) {
    process.exitCode = 1;
  }
}

function checkAround(checks, name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: String(error) });
  }
}

try {
  if (mode === "crash-pre-commit") {
    const dbPath = join(ownTempDir, "state.db");
    const db = openDatabase(dbPath);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, value BIGINT)");
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO t (id, value) VALUES (?, ?)").run(1, 9007199254740993n);
    db.exec("COMMIT");
    // 第二行只写入未提交事务；父进程将在检查点强杀本 Worker。
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO t (id, value) VALUES (?, ?)").run(2, 1n);
    parentPort?.postMessage({ mode, checkpoint: "pre-commit", dbPath });
    blockForever();
  }

  if (mode === "verify-recovery") {
    const checks = [];
    const db = openDatabase(inheritedDbPath);
    checkAround(checks, "wal-after-crash", () => {
      const row = db.prepare("PRAGMA journal_mode").get();
      const journal = String(row?.journal_mode ?? "").toLowerCase();
      if (journal !== "wal") {
        throw new Error(`journal_mode=${journal}`);
      }
    });
    checkAround(checks, "committed-row-survives", () => {
      const row = readBigIntRow(db, 1);
      if (row?.value !== 9007199254740993n) {
        throw new Error(`value=${String(row?.value)}`);
      }
    });
    checkAround(checks, "uncommitted-row-rolled-back", () => {
      const row = readBigIntRow(db, 2);
      if (row !== undefined) {
        throw new Error("row from the killed transaction is visible");
      }
    });
    checkAround(checks, "integrity-ok", () => {
      const row = db.prepare("PRAGMA integrity_check").get();
      if (String(row?.integrity_check ?? "") !== "ok") {
        throw new Error(`integrity_check=${String(row?.integrity_check)}`);
      }
    });
    db.close();
    report(checks);
  }

  if (mode === "baseline") {
    const dbPath = join(ownTempDir, "state.db");
    const checks = [];
    const db = openDatabase(dbPath);

    checkAround(checks, "wal-mode", () => {
      const row = db.prepare("PRAGMA journal_mode").get();
      const journal = String(row?.journal_mode ?? "").toLowerCase();
      if (journal !== "wal") {
        throw new Error(`journal_mode=${journal}`);
      }
    });

    checkAround(checks, "transaction-commit", () => {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, value BIGINT)");
      db.exec("BEGIN IMMEDIATE");
      // 2^53+1：超过 JSON 安全整数，验证 BigInt 无损存取。
      db.prepare("INSERT INTO t (id, value) VALUES (?, ?)").run(1, 9007199254740993n);
      db.exec("COMMIT");
    });

    checkAround(checks, "bigint-read", () => {
      const row = readBigIntRow(db, 1);
      if (row?.value !== 9007199254740993n) {
        throw new Error(`value=${String(row?.value)}`);
      }
    });

    checkAround(checks, "transaction-rollback", () => {
      db.exec("BEGIN IMMEDIATE");
      db.prepare("INSERT INTO t (id, value) VALUES (?, ?)").run(2, 1n);
      db.exec("ROLLBACK");
      const row = db.prepare("SELECT COUNT(*) AS n FROM t WHERE id = 2").get();
      if (Number(row?.n ?? 0) !== 0) {
        throw new Error("rolled-back row still visible");
      }
    });

    db.close();

    checkAround(checks, "reopen-persistent", () => {
      const reopened = new DatabaseSync(dbPath);
      const row = readBigIntRow(reopened, 1);
      reopened.close();
      if (row?.value !== 9007199254740993n) {
        throw new Error(`value=${String(row?.value)}`);
      }
    });

    report(checks);
  }
} finally {
  // crash-pre-commit 的目录由父进程在恢复验证后清理；verify-recovery
  // 没有自有目录；baseline 自清理。
  if (ownTempDir !== null && mode === "baseline") {
    rmSync(ownTempDir, { recursive: true, force: true });
  }
}
