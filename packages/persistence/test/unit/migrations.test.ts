import { describe, expect, it } from "vitest";
import { validateMigrationRegistry } from "../../src/migrations/definition.js";
import type { MigrationDefinition } from "../../src/migrations/definition.js";
import { migrationChecksum, runMigrations } from "../../src/migrations/runner.js";
import { PersistenceError } from "../../src/errors.js";
import type {
  SqliteDatabase,
  SqliteRow,
  SqliteStatement,
  SqliteValue,
} from "../../src/repositories/sqlite-port.js";
import { STATE_MIGRATIONS } from "../../src/migrations/registry.js";

/**
 * Migration Runner 单元测试（docs/protocols/persistence-and-recovery.md）。
 * SQL 真实执行行为由集成测试覆盖；这里用内存假库验证排序、checksum、
 * 幂等、篡改拒绝与失败回滚的事务边界。
 */

interface FakeBelt {
  sql: string;
  params: readonly SqliteValue[];
}

class FakeStatement implements SqliteStatement {
  readonly #belt: FakeBelt;
  #results: readonly SqliteRow[];

  constructor(belt: FakeBelt, results: readonly SqliteRow[]) {
    this.#belt = belt;
    this.#results = results;
  }

  run(...params: readonly SqliteValue[]) {
    this.#belt.params = params;
    return { changes: 1, lastInsertRowid: 1 };
  }

  get(..._params: readonly SqliteValue[]) {
    return this.#results[0];
  }

  all(..._params: readonly SqliteValue[]) {
    return this.#results;
  }
}

class FakeDatabase implements SqliteDatabase {
  readonly executedSql: string[] = [];
  readonly statements: FakeBelt[] = [];
  applied: Array<{ version: number; checksum: string }> = [];
  failOnSql: string | null = null;

  exec(sql: string): void {
    if (sql.startsWith("ROLLBACK")) {
      const last = this.executedSql.at(-1);
      if (last?.startsWith("BEGIN")) {
        this.executedSql.pop();
        return;
      }
    }
    if (this.failOnSql !== null && sql.includes(this.failOnSql)) {
      throw new Error(`SQLITE_ERROR: simulated failure in: ${sql.slice(0, 40)}`);
    }
    this.executedSql.push(sql);
  }

  prepare(sql: string): SqliteStatement {
    const belt: FakeBelt = { sql, params: [] };
    this.statements.push(belt);
    const results: readonly SqliteRow[] = sql.includes("FROM schema_migrations")
      ? this.applied.map(
          (row) =>
            ({
              version: row.version,
              checksum: row.checksum,
            }) as SqliteRow,
        )
      : [];
    return new FakeStatement(belt, results);
  }

  /** statement.run(schema_migrations 插入) 时记录 applied。 */
  recordAppliedInserts(): void {
    for (const belt of this.statements) {
      if (belt.sql.startsWith("INSERT INTO schema_migrations") && belt.params.length === 4) {
        const version = Number(belt.params[0]);
        const checksum = String(belt.params[2]);
        if (!this.applied.some((row) => row.version === version)) {
          this.applied.push({ version, checksum });
        }
      }
    }
  }
}

function migration(version: number, sql: string, name = `m${version}`): MigrationDefinition {
  return { version, name, sql: sql || `-- migration ${version}` };
}

describe("validateMigrationRegistry", () => {
  it("接受从 1 开始的连续版本", () => {
    expect(() => validateMigrationRegistry([migration(1, "a"), migration(2, "b")])).not.toThrow();
  });

  it("拒绝缺口", () => {
    expect(() => validateMigrationRegistry([migration(1, "a"), migration(3, "c")])).toThrow(
      /expected version 2/,
    );
  });

  it("拒绝重复版本", () => {
    expect(() =>
      validateMigrationRegistry([migration(1, "a"), migration(2, "b"), migration(2, "b")]),
    ).toThrow();
  });

  it("拒绝不从 1 开始", () => {
    expect(() => validateMigrationRegistry([migration(2, "b")])).toThrow(/expected version 1/);
  });
});

describe("runMigrations", () => {
  it("按序执行未应用的 Migration 并记录 checksum", () => {
    const db = new FakeDatabase();
    runMigrations(db, [migration(1, "CREATE TABLE a"), migration(2, "CREATE TABLE b")], 1);
    db.recordAppliedInserts();
    expect(db.executedSql).toContain("CREATE TABLE a");
    expect(db.executedSql).toContain("CREATE TABLE b");
    expect(db.applied).toEqual([
      { version: 1, checksum: migrationChecksum(migration(1, "CREATE TABLE a")) },
      { version: 2, checksum: migrationChecksum(migration(2, "CREATE TABLE b")) },
    ]);
  });

  it("重复 migrate 幂等：已应用版本跳过", () => {
    const db = new FakeDatabase();
    const registry = [migration(1, "CREATE TABLE a")];
    runMigrations(db, registry, 1);
    db.recordAppliedInserts();
    const countMigrationSql = () => db.executedSql.filter((sql) => sql === "CREATE TABLE a").length;
    expect(countMigrationSql()).toBe(1);
    runMigrations(db, registry, 2);
    // 已应用版本不重跑；仅 bootstrap（IF NOT EXISTS）幂等重放一次。
    expect(countMigrationSql()).toBe(1);
  });

  it("已应用版本 checksum 变化时拒绝（不可原地改写）", () => {
    const db = new FakeDatabase();
    runMigrations(db, [migration(1, "CREATE TABLE a")], 1);
    db.recordAppliedInserts();
    expect(() => runMigrations(db, [migration(1, "CREATE TABLE a -- 改写")], 2)).toThrow(
      PersistenceError,
    );
    try {
      runMigrations(db, [migration(1, "CREATE TABLE a -- 改写")], 2);
    } catch (error) {
      expect((error as PersistenceError).code).toBe("migration_checksum_mismatch");
    }
  });

  it("库中存在注册表外的已应用版本时拒绝", () => {
    const db = new FakeDatabase();
    db.applied.push({ version: 99, checksum: "deadbeef" });
    expect(() => runMigrations(db, [migration(1, "CREATE TABLE a")], 1)).toThrow(PersistenceError);
  });

  it("单个 Migration 失败时回滚该事务（bootstrap 外无残留）", () => {
    const db = new FakeDatabase();
    db.failOnSql = "CREATE TABLE bad";
    expect(() =>
      runMigrations(db, [migration(1, "CREATE TABLE a"), migration(2, "CREATE TABLE bad")], 1),
    ).toThrow(/simulated failure/);
    db.recordAppliedInserts();
    // Migration 1 已提交；Migration 2 完全未应用（下次可续跑）。
    expect(db.applied.map((row) => row.version)).toEqual([1]);
  });

  it("内置 state 注册表合法且 checksum 稳定", () => {
    expect(() => validateMigrationRegistry(STATE_MIGRATIONS)).not.toThrow();
    expect(migrationChecksum(STATE_MIGRATIONS[0] as MigrationDefinition)).toMatch(/^[0-9a-f]{64}$/);
  });
});
