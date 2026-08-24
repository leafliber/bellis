import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import { PersistenceError } from "../errors.js";
import type {
  SqliteDatabase,
  SqliteRow,
  SqliteRunResult,
  SqliteStatement,
  SqliteValue,
} from "../repositories/sqlite-port.js";

/**
 * 真实 SQLite 连接（全包唯一允许导入 node:sqlite 的文件）。
 *
 * - state.db：synchronous=FULL；telemetry.db：synchronous=NORMAL；
 *   两者都启用 WAL、Foreign Keys、busy_timeout=3000（docs/protocols/persistence-and-recovery.md）。
 * - Worker 启动记录 bootEpochMs + bootMonotonicUs 锚点，运行期间
 *   leaseNowMs 用单调增量投影，同一 Worker 生命周期不反复读取墙钟，
 *   NTP 跳变不影响 Lease 判断。
 * - 测试注入：wallClockMs 固定审计墙钟；recordIds 预置 recordId 序列。
 */

class StatementAdapter implements SqliteStatement {
  readonly #statement: StatementSync;

  constructor(statement: StatementSync) {
    this.#statement = statement;
  }

  run(...params: readonly SqliteValue[]): SqliteRunResult {
    return this.#statement.run(...params) as SqliteRunResult;
  }

  get(...params: readonly SqliteValue[]): SqliteRow | undefined {
    return this.#statement.get(...params) as SqliteRow | undefined;
  }

  all(...params: readonly SqliteValue[]): readonly SqliteRow[] {
    return this.#statement.all(...params) as SqliteRow[];
  }
}

class DatabaseAdapter implements SqliteDatabase {
  readonly #db: DatabaseSync;
  #closed = false;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    return new StatementAdapter(this.#db.prepare(sql));
  }

  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#db.close();
    }
  }
}

export interface LeaseClock {
  readonly bootEpochMs: number;
  leaseNowMs(): number;
}

export function createLeaseClock(): LeaseClock {
  const bootEpochMs = Date.now();
  const bootMonotonicNs = process.hrtime.bigint();
  return {
    bootEpochMs,
    leaseNowMs: () =>
      bootEpochMs + Math.round(Number(process.hrtime.bigint() - bootMonotonicNs) / 1_000_000),
  };
}

export const WORKER_LOCK_FILE = "worker-lock.db";

/**
 * 单 Worker 独占守卫（评审阻断项 4）。
 *
 * 同一数据目录只允许一个 DB Worker：守卫库以 locking_mode=EXCLUSIVE
 * 打开，首次写后持久持有文件锁；第二个 Worker 的任何访问都会
 * SQLITE_BUSY。进程死亡（含 SIGKILL）时 OS 释放文件锁，重启即可
 * 接管——因此 migrate() 的启动恢复（in_flight 全量重排队）不可能
 * 抢走仍存活 Worker 的活跃 Lease。
 */
class WorkerLock {
  readonly #db: DatabaseSync;

  constructor(dataDirectory: string) {
    mkdirSync(dataDirectory, { recursive: true });
    const db = new DatabaseSync(join(dataDirectory, WORKER_LOCK_FILE));
    try {
      db.exec("PRAGMA busy_timeout = 500;");
      db.exec("PRAGMA locking_mode = EXCLUSIVE;");
      db.exec(
        "CREATE TABLE IF NOT EXISTS worker_lock (id INTEGER PRIMARY KEY CHECK (id = 1), acquired_at_ms INTEGER NOT NULL) STRICT;",
      );
      db.prepare("INSERT OR REPLACE INTO worker_lock (id, acquired_at_ms) VALUES (1, ?)").run(
        Date.now(),
      );
    } catch (error) {
      db.close();
      if (/BUSY|locked/i.test(String(error))) {
        throw new PersistenceError(
          "unavailable",
          "another persistence worker already owns this data directory",
          { cause: error },
        );
      }
      throw error;
    }
    this.#db = db;
  }

  close(): void {
    this.#db.close();
  }
}

function openDatabase(path: string, synchronous: "FULL" | "NORMAL"): DatabaseAdapter {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`PRAGMA synchronous = ${synchronous};`);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 3000;");
  return new DatabaseAdapter(db);
}

export class WorkerDatabases {
  readonly state: DatabaseAdapter;
  readonly telemetry: DatabaseAdapter;
  readonly leaseClock: LeaseClock;
  readonly #lock: WorkerLock;
  readonly #fixedWallClockMs: number | null;
  readonly #recordIds: readonly string[];
  #recordIdIndex = 0;

  constructor(options: {
    readonly dataDirectory: string;
    readonly wallClockMs?: number | undefined;
    readonly recordIds?: readonly string[] | undefined;
  }) {
    // 先取独占守卫，再打开业务库：同目录第二个 Worker 在此处即失败。
    this.#lock = new WorkerLock(options.dataDirectory);
    this.state = openDatabase(join(options.dataDirectory, "state.db"), "FULL");
    this.telemetry = openDatabase(join(options.dataDirectory, "telemetry.db"), "NORMAL");
    this.leaseClock = createLeaseClock();
    this.#fixedWallClockMs = options.wallClockMs ?? null;
    this.#recordIds = options.recordIds ?? [];
  }

  nowMs(): number {
    return this.#fixedWallClockMs ?? Date.now();
  }

  newRecordId(fallback: () => string): string {
    const preset = this.#recordIds[this.#recordIdIndex];
    if (preset !== undefined) {
      this.#recordIdIndex += 1;
      return preset;
    }
    return fallback();
  }

  close(): void {
    this.state.close();
    this.telemetry.close();
    this.#lock.close();
  }
}
