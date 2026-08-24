import { createHash } from "node:crypto";
import { PersistenceError } from "../errors.js";
import type { SqliteDatabase } from "../repositories/sqlite-port.js";
import type { MigrationDefinition } from "./definition.js";

/**
 * 有 checksum 的前向 Migration Runner（docs/protocols/persistence-and-recovery.md）。
 *
 * - schema_migrations 是唯一的 bootstrap 表（CREATE IF NOT EXISTS，
 *   在版本化 Migration 之外，仅这一处允许 IF NOT EXISTS）。
 * - 单个 Migration 在事务中执行并记录 SQL 文本的 SHA-256 checksum。
 * - 已应用版本 checksum 变化 → migration_checksum_mismatch。
 * - 库中存在注册表外的版本 / 注册表自身缺口、重复 → migration_invalid。
 * - 任一 Migration 失败：该事务回滚，之前已提交的 Migration 保持
 *   （下次 migrate 从断点续跑），Client 不进入 Ready。
 */

const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL
) STRICT;
`;

export function migrationChecksum(migration: MigrationDefinition): string {
  return createHash("sha256").update(migration.sql, "utf8").digest("hex");
}

interface AppliedRow {
  readonly version: number;
  readonly checksum: string;
}

export function runMigrations(
  db: SqliteDatabase,
  migrations: readonly MigrationDefinition[],
  appliedAtMs: number,
): void {
  db.exec(BOOTSTRAP_SQL);
  const applied = db
    .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
    .all()
    .map((row) => ({
      version: Number(row["version"]),
      checksum: String(row["checksum"]),
    })) as AppliedRow[];

  const registryByIndex = new Map<number, MigrationDefinition>();
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new PersistenceError(
        "migration_invalid",
        `migration registry must be contiguous from 1 (got ${migration.name}@${migration.version})`,
      );
    }
    registryByIndex.set(migration.version, migration);
  });

  for (const row of applied) {
    const migration = registryByIndex.get(row.version);
    if (migration === undefined) {
      throw new PersistenceError(
        "migration_invalid",
        `applied migration ${row.version} is not in the registry`,
      );
    }
    if (migrationChecksum(migration) !== row.checksum) {
      throw new PersistenceError(
        "migration_checksum_mismatch",
        `migration ${row.version} (${migration.name}) checksum changed after being applied`,
      );
    }
  }

  for (const migration of migrations) {
    if (applied.some((row) => row.version === migration.version)) {
      continue;
    }
    const checksum = migrationChecksum(migration);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)",
      ).run(migration.version, migration.name, checksum, appliedAtMs);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
