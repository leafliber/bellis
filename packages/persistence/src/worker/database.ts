import { DiskAdmission } from "./disk-admission.js";
import { diskAdmissionOptions } from "../disk-admission.js";
import { mkdirSync, statSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, constants } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import { PersistenceError } from "../errors.js";
import {
  completionCacheBytes,
  MAX_COMPLETION_COUNTS,
  completionBudget,
  transactionWalBytes,
  transactionAuxiliaryBytes,
  type CompletionCounts,
  type CompletionOperation,
} from "../completion-budget.js";
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

const completionUnavailable = () =>
  new PersistenceError("storage_not_ready", "effect completion capacity is reserved");

function sqliteCall<T>(body: () => T, onFull?: (guard?: boolean) => void): T {
  try {
    return body();
  } catch (error) {
    const code = (error as { errcode?: unknown } | null)?.errcode;
    // This connection's native guard owns INTERRUPT and CONSTRAINT_COMMITHOOK.
    // Both reject before WAL commit and may roll back an outer transaction.
    if (code === 9 || code === 531) {
      onFull?.(true);
      throw new PersistenceError(
        "storage_not_ready",
        "persistence transaction capacity exhausted",
        { cause: error },
      );
    }
    if (typeof code === "number" && (code & 0xff) === 13) {
      onFull?.();
      throw new PersistenceError("storage_not_ready", "persistence database capacity exhausted", {
        cause: error,
      });
    }
    throw error;
  }
}

class StatementAdapter implements SqliteStatement {
  readonly #statement: StatementSync;
  readonly #onFull: (guard?: boolean) => void;
  readonly #before: () => void;

  constructor(statement: StatementSync, onFull: (guard?: boolean) => void, before: () => void) {
    this.#statement = statement;
    this.#onFull = onFull;
    this.#before = before;
  }

  get sourceLength(): number {
    return this.#statement.sourceSQL.length;
  }

  run(...params: readonly SqliteValue[]): SqliteRunResult {
    this.#before();
    return sqliteCall(() => this.#statement.run(...params), this.#onFull) as SqliteRunResult;
  }

  get(...params: readonly SqliteValue[]): SqliteRow | undefined {
    this.#before();
    return sqliteCall(() => this.#statement.get(...params), this.#onFull) as SqliteRow | undefined;
  }

  all(...params: readonly SqliteValue[]): readonly SqliteRow[] {
    this.#before();
    return sqliteCall(() => this.#statement.all(...params), this.#onFull) as SqliteRow[];
  }
}

class DatabaseAdapter implements SqliteDatabase {
  readonly #db: DatabaseSync;
  #closed = false;
  #autoRolledBack = false;
  readonly #walPath: string;
  readonly #walHighWaterBytes: number;
  readonly #transactionCacheMaxBytes: number;
  #currentCacheMaxBytes: number;
  #completion: CompletionOperation | undefined;
  #admission: ((operation?: CompletionOperation) => PersistenceError | undefined) | undefined;
  #writeError: PersistenceError | undefined;
  #reserveEnabled = false;
  #collecting = false;
  #writes = false;
  #maintenance = false;
  #transactionAdmitted = false;
  readonly #onFull = (guard = false) => {
    this.#maintenance = true;
    try {
      // An interrupt during SQL compilation need not roll back an outer TX.
      // The native guard is suspended after tripping, so cleanup can finish.
      if (guard && this.#db.isTransaction) this.#db.exec("ROLLBACK");
      this.#autoRolledBack = !this.#db.isTransaction;
      this.#db.exec("PRAGMA shrink_memory");
      this.#db.prepare("SELECT bellis_guard(?)").get(this.#currentCacheMaxBytes);
    } finally {
      this.#maintenance = false;
    }
  };

  constructor(
    db: DatabaseSync,
    path: string,
    walHighWaterBytes: number,
    transactionCacheMaxBytes: number,
  ) {
    this.#db = db;
    this.#walPath = `${path}-wal`;
    this.#walHighWaterBytes = walHighWaterBytes;
    this.#transactionCacheMaxBytes = transactionCacheMaxBytes;
    this.#currentCacheMaxBytes = transactionCacheMaxBytes;
    db.setAuthorizer((action, _arg1, arg2) => {
      if (this.#maintenance) return constants.SQLITE_OK;
      if (
        action === constants.SQLITE_PRAGMA &&
        (_arg1 === "quick_check" || _arg1 === "integrity_check")
      )
        return constants.SQLITE_OK;
      if (
        action === constants.SQLITE_PRAGMA ||
        action === constants.SQLITE_ATTACH ||
        action === constants.SQLITE_DETACH ||
        (action === constants.SQLITE_FUNCTION &&
          (arg2?.toLowerCase() === "bellis_guard" || arg2?.toLowerCase() === "load_extension"))
      )
        throw new PersistenceError(
          "invalid_request",
          "persistence storage settings are owned by the Worker",
        );
      if (!db.isTransaction) this.#transactionAdmitted = false;
      // Classify SQLite operations, including CTEs, triggers and RETURNING,
      // rather than relying on SQL prefixes or which Statement method is used.
      if (
        [
          constants.SQLITE_READ,
          constants.SQLITE_SELECT,
          constants.SQLITE_FUNCTION,
          constants.SQLITE_RECURSIVE,
          constants.SQLITE_TRANSACTION,
          constants.SQLITE_SAVEPOINT,
        ].includes(action)
      )
        return constants.SQLITE_OK;
      if (this.#collecting) this.#writes = true;
      else this.#assertWrite();
      return constants.SQLITE_OK;
    });
  }

  #walBytes(): number {
    try {
      return statSync(this.#walPath).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw new PersistenceError("storage_not_ready", "persistence WAL state unavailable");
    }
  }

  #checkpoint(): void {
    if (this.#db.isTransaction) return;
    this.#transactionAdmitted = false;
    if (this.#walBytes() >= this.#walHighWaterBytes) {
      this.#maintenance = true;
      try {
        // A pinned reader must not stall the Worker for its normal busy timeout.
        this.#db.exec("PRAGMA busy_timeout = 0");
        sqliteCall(() => this.#db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(), this.#onFull);
      } finally {
        try {
          this.#db.exec("PRAGMA busy_timeout = 3000");
        } finally {
          this.#maintenance = false;
        }
      }
    }
    this.#writeError = this.#admission?.(this.#completion);
  }

  #assertWrite(): void {
    if (!this.#db.isTransaction) this.#transactionAdmitted = false;
    if (this.#transactionAdmitted) return;
    if (this.#writeError) throw this.#writeError;
    if (this.#completion === undefined && this.#walBytes() >= this.#walHighWaterBytes)
      throw new PersistenceError("storage_not_ready", "persistence WAL checkpoint required");
    if (this.#db.isTransaction) this.#transactionAdmitted = true;
  }

  exec(sql: string): void {
    // SQLITE_FULL may already have rolled back the entire transaction. Preserve
    // the original safe capacity error instead of masking it with a second ROLLBACK.
    if (this.#autoRolledBack && /^\s*ROLLBACK\s*;?\s*$/i.test(sql) && !this.#db.isTransaction)
      return;
    if (
      this.#autoRolledBack &&
      !this.#db.isTransaction &&
      /^\s*(ROLLBACK\s+TO\s+|RELEASE\s+)/i.test(sql)
    )
      return;
    this.#autoRolledBack = false;
    // Compile one real SQLite statement at a time. A multi-statement exec may
    // contain multiple transactions; each must obtain a fresh quota snapshot.
    let rest = sql;
    while (true) {
      rest = rest.replace(/^(?:[\s;]+|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?(?:\*\/|$))+/, "");
      if (!rest) break;
      const statement = this.prepare(rest) as StatementAdapter;
      const consumed = statement.sourceLength;
      if (consumed < 1) throw new PersistenceError("internal", "empty persistence statement");
      statement.run();
      rest = rest.slice(consumed);
    }
  }

  prepare(sql: string): SqliteStatement {
    this.#writes = false;
    this.#collecting = true;
    let statement: StatementSync;
    try {
      statement = sqliteCall(() => this.#db.prepare(sql), this.#onFull);
    } finally {
      this.#collecting = false;
    }
    const writes = this.#writes;
    return new StatementAdapter(statement, this.#onFull, () => {
      this.#checkpoint();
      if (writes) this.#assertWrite();
    });
  }

  capacity() {
    this.#checkpoint();
    return this.rawCapacity();
  }

  rawCapacity() {
    this.#maintenance = true;
    try {
      const scalar = (name: string) => Number(this.#db.prepare(`PRAGMA ${name}`).get()![name]);
      const pageSize = scalar("page_size");
      const allocated = scalar("page_count");
      return {
        // With cache spill disabled, the commit hook bounds the cached page
        // images. Add frame headers, one full padding frame and a 64KiB sector.
        walLimitBytes:
          this.#walHighWaterBytes +
          transactionWalBytes(this.#transactionCacheMaxBytes, pageSize) +
          (this.#reserveEnabled ? completionBudget(MAX_COMPLETION_COUNTS, pageSize).walBytes : 0),
        pageSize,
        limitBytes: scalar("max_page_count") * pageSize,
        allocatedBytes: allocated * pageSize,
        usedBytes: (allocated - scalar("freelist_count")) * pageSize,
      };
    } finally {
      this.#maintenance = false;
    }
  }

  setWriteAdmission(
    admission: (operation?: CompletionOperation) => PersistenceError | undefined,
    reserveEnabled = false,
  ): void {
    this.#admission = admission;
    this.#reserveEnabled = reserveEnabled;
  }

  reservationSnapshot(sceneId?: string) {
    this.#maintenance = true;
    try {
      if (
        !this.#db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='phase4_completion_reservations'",
          )
          .get()
      )
        return { bindings: 0, confirmations: 0, closes: 0, own: undefined };
      const total = this.#db
        .prepare(
          "SELECT COALESCE(SUM(bindings_remaining),0) AS bindings, COALESCE(SUM(confirmations_remaining),0) AS confirmations, COUNT(*) AS closes FROM phase4_completion_reservations",
        )
        .get()!;
      const own =
        sceneId === undefined
          ? undefined
          : this.#db
              .prepare(
                "SELECT bindings_remaining AS bindings, confirmations_remaining AS confirmations FROM phase4_completion_reservations WHERE scene_id=?",
              )
              .get(sceneId);
      return {
        bindings: Number(total.bindings),
        confirmations: Number(total.confirmations),
        closes: Number(total.closes),
        own,
      };
    } finally {
      this.#maintenance = false;
    }
  }

  #enterCompletionBudget(operation: CompletionOperation): () => void {
    if (this.#db.isTransaction || this.#completion)
      throw new PersistenceError("internal", "nested completion budget");
    const configure = (bytes: number, cacheKiB: number) => {
      this.#maintenance = true;
      try {
        this.#db.exec("PRAGMA shrink_memory");
        this.#db.exec(`PRAGMA cache_size=-${cacheKiB}`);
        this.#db.prepare("SELECT bellis_guard(?)").get(bytes);
        this.#currentCacheMaxBytes = bytes;
      } finally {
        this.#maintenance = false;
      }
    };
    configure(completionCacheBytes(operation.kind, this.rawCapacity().pageSize), 128);
    this.#completion = operation;
    return () => {
      this.#completion = undefined;
      configure(this.#transactionCacheMaxBytes, 2000);
    };
  }

  withCompletionBudget<T>(operation: CompletionOperation, body: () => T): T {
    const release = this.#enterCompletionBudget(operation);
    try {
      return body();
    } finally {
      release();
    }
  }

  async withCompletionBudgetAsync<T>(
    operation: CompletionOperation,
    body: () => Promise<T>,
  ): Promise<T> {
    const release = this.#enterCompletionBudget(operation);
    try {
      return await body();
    } finally {
      release();
    }
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

function openDatabase(
  path: string,
  synchronous: "FULL" | "NORMAL",
  maxBytes: number,
  walHighWaterBytes: number,
  transactionCacheMaxBytes: number,
): DatabaseAdapter {
  const db = new DatabaseSync(path, { allowExtension: true });
  try {
    const suffix =
      process.platform === "win32" ? ".dll" : process.platform === "darwin" ? ".dylib" : ".so";
    try {
      db.loadExtension(
        fileURLToPath(new URL(`../../dist/native/bellisguard${suffix}`, import.meta.url)),
        "sqlite3_bellisguard_init",
      );
    } finally {
      db.enableLoadExtension(false);
    }
    try {
      if (db.prepare("SELECT bellis_guard(-1) AS version").get()!.version !== 2)
        throw new Error("guard ABI mismatch");
    } catch (error) {
      throw new PersistenceError("storage_not_ready", "transaction capacity guard unavailable", {
        cause: error,
      });
    }
    db.prepare("SELECT bellis_guard(?)").get(transactionCacheMaxBytes);
    db.exec("PRAGMA cache_spill = OFF;");
    if (db.prepare("PRAGMA cache_spill").get()!.cache_spill !== 0)
      throw new PersistenceError("storage_not_ready", "transaction capacity guard unavailable");
    const pageSize = Number(db.prepare("PRAGMA page_size").get()!.page_size);
    const maxPages = Math.floor(maxBytes / pageSize);
    const existingPages = Number(db.prepare("PRAGMA page_count").get()!.page_count);
    if (existingPages > maxPages)
      throw new PersistenceError(
        "storage_not_ready",
        "existing database exceeds configured capacity",
      );
    const applied = Number(db.prepare(`PRAGMA max_page_count = ${maxPages}`).get()!.max_page_count);
    if (applied !== maxPages)
      throw new PersistenceError("storage_not_ready", "database capacity limit unavailable");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(`PRAGMA synchronous = ${synchronous};`);
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 3000;");
    return new DatabaseAdapter(db, path, walHighWaterBytes, transactionCacheMaxBytes);
  } catch (error) {
    db.close();
    throw error;
  }
}

export class WorkerDatabases {
  readonly diskAdmission: DiskAdmission;
  readonly state: DatabaseAdapter;
  readonly telemetry: DatabaseAdapter;
  readonly leaseClock: LeaseClock;
  readonly #lock: WorkerLock;
  readonly #dataDirectory: string;
  readonly #normalCacheBytes: number;
  readonly #fixedWallClockMs: number | null;
  readonly #recordIds: readonly string[];
  #recordIdIndex = 0;

  constructor(options: {
    readonly dataDirectory: string;
    readonly diskAdmission?:
      | import("../disk-admission.js").PersistenceDiskAdmissionOptions
      | undefined;
    readonly wallClockMs?: number | undefined;
    readonly recordIds?: readonly string[] | undefined;
  }) {
    const budget = diskAdmissionOptions(options.diskAdmission);
    this.#dataDirectory = options.dataDirectory;
    this.#normalCacheBytes = budget.transactionCacheMaxBytes;
    // 先取独占守卫，再打开业务库：同目录第二个 Worker 在此处即失败。
    this.#lock = new WorkerLock(options.dataDirectory);
    let state: DatabaseAdapter | undefined;
    let telemetry: DatabaseAdapter | undefined;
    try {
      state = openDatabase(
        join(options.dataDirectory, "state.db"),
        "FULL",
        budget.stateMaxBytes,
        budget.walHighWaterBytes,
        budget.transactionCacheMaxBytes,
      );
      telemetry = openDatabase(
        join(options.dataDirectory, "telemetry.db"),
        "NORMAL",
        budget.telemetryMaxBytes,
        budget.walHighWaterBytes,
        budget.transactionCacheMaxBytes,
      );
      this.state = state;
      this.telemetry = telemetry;
      state.setWriteAdmission((operation) => this.#writeAdmission("state", operation), true);
      telemetry.setWriteAdmission(() => this.#writeAdmission("telemetry"));
      this.diskAdmission = new DiskAdmission(options.dataDirectory, options.diskAdmission, () => {
        const s = this.state.capacity(),
          t = this.telemetry.capacity();
        const reservations = this.state.reservationSnapshot();
        const reserved = completionBudget(reservations, s.pageSize);
        return {
          stateLimitBytes: s.limitBytes,
          stateWalLimitBytes: s.walLimitBytes,
          stateAllocatedBytes: s.allocatedBytes,
          stateUsedBytes: s.usedBytes,
          stateReservedBytes: reserved.databaseBytes,
          stateReservedWalBytes: reserved.walBytes,
          stateReservedAuxiliaryBytes: reserved.auxiliaryBytes,
          activeCompletionReservations: reservations.closes,
          telemetryLimitBytes: t.limitBytes,
          telemetryWalLimitBytes: t.walLimitBytes,
          telemetryAllocatedBytes: t.allocatedBytes,
          telemetryUsedBytes: t.usedBytes,
        };
      });
    } catch (error) {
      try {
        state?.close();
      } finally {
        try {
          telemetry?.close();
        } finally {
          this.#lock.close();
        }
      }
      throw error;
    }
    this.leaseClock = createLeaseClock();
    this.#fixedWallClockMs = options.wallClockMs ?? null;
    this.#recordIds = options.recordIds ?? [];
  }

  #writeAdmission(
    database: "state" | "telemetry",
    operation?: CompletionOperation,
    extra?: CompletionCounts,
  ): PersistenceError | undefined {
    try {
      const state = this.state.rawCapacity(),
        telemetry = this.telemetry.rawCapacity();
      const counts = this.state.reservationSnapshot(operation?.sceneId);
      const total = {
        bindings: counts.bindings + (extra?.bindings ?? 0),
        confirmations: counts.confirmations + (extra?.confirmations ?? 0),
        closes: counts.closes + (extra?.closes ?? 0),
      };
      if (operation) {
        const remaining =
          operation.kind === "close"
            ? counts.own
              ? 1
              : 0
            : Number(
                counts.own?.[operation.kind === "binding" ? "bindings" : "confirmations"] ?? 0,
              );
        if (remaining < 1) return completionUnavailable();
      }
      if (total.closes === 0) return undefined;
      if (total.closes > 4 || total.bindings > 128 || total.confirmations > 128)
        return completionUnavailable();
      const reserved = completionBudget(total, state.pageSize);
      const normalGrowth = operation ? 0 : this.#normalCacheBytes;
      if (
        state.usedBytes + reserved.databaseBytes + (database === "state" ? normalGrowth : 0) >
        state.limitBytes
      )
        return completionUnavailable();
      const fileSize = (name: string) => {
        try {
          return statSync(join(this.#dataDirectory, name)).size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT" && name.endsWith("-wal")) return 0;
          throw error;
        }
      };
      if (
        fileSize("state.db-wal") +
          reserved.walBytes +
          (database === "state" && !operation
            ? transactionWalBytes(normalGrowth, state.pageSize)
            : 0) >
        state.walLimitBytes
      )
        return completionUnavailable();
      // Already committed WAL pages may still need physical DB file allocation
      // at checkpoint. Account for that obligation as well as future credits.
      const unmaterialized =
        Math.max(0, state.allocatedBytes - fileSize("state.db")) +
        Math.max(0, telemetry.allocatedBytes - fileSize("telemetry.db"));
      const fs = statfsSync(this.#dataDirectory, { bigint: true });
      const available = fs.bavail * fs.bsize;
      const normalPhysical = operation
        ? 0
        : normalGrowth +
          transactionWalBytes(
            normalGrowth,
            database === "state" ? state.pageSize : telemetry.pageSize,
          ) +
          transactionAuxiliaryBytes(
            normalGrowth,
            database === "state" ? state.pageSize : telemetry.pageSize,
          );
      if (
        available <
        BigInt(
          reserved.databaseBytes +
            reserved.walBytes +
            reserved.auxiliaryBytes +
            unmaterialized +
            normalPhysical +
            1024 ** 2,
        )
      )
        return completionUnavailable();
      return undefined;
    } catch {
      return completionUnavailable();
    }
  }

  assertEffectReservation = (counts: CompletionCounts): void => {
    const error = this.#writeAdmission("state", undefined, counts);
    if (error) throw error;
  };

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
