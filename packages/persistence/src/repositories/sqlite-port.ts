/**
 * 中性 SQLite 端口：Repository 只依赖这两个接口，不导入 node:sqlite。
 * 真实实现由 Worker 的 database.ts（唯一允许导入 node:sqlite 的文件）注入，
 * 因此 Repository 语义可在主线程单元测试中用内联假实现验证，
 * 而 PRAGMA/事务/并发等真实行为在 Worker 集成测试中验证。
 *
 * 数值约定：所有可能超过 2^53 的整数（Watermark/Server Seq/Aggregate Seq）
 * 一律以十进制 TEXT 存取，绝不经过 JS number；行对象中的 INTEGER 列
 * 由调用方约束在安全整数范围内（epoch ms / 计数）。
 */

export type SqliteValue = string | number | bigint | null;

export interface SqliteRunResult {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

export interface SqliteRow {
  readonly [column: string]: SqliteValue | Uint8Array;
}

export interface SqliteStatement {
  run(...params: readonly SqliteValue[]): SqliteRunResult;
  get(...params: readonly SqliteValue[]): SqliteRow | undefined;
  all(...params: readonly SqliteValue[]): readonly SqliteRow[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

/** 读取 TEXT 列并断言类型（STRICT 表保证 TEXT 列不会出现其他类型）。 */
export function readText(row: SqliteRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new Error(`column ${column} is not TEXT`);
  }
  return value;
}

/** 读取安全整数范围内的 INTEGER 列。 */
export function readInt(row: SqliteRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`column ${column} is not a safe integer`);
  }
  return value;
}

/** 读取可空 TEXT 列（NULL 或缺失按 null 处理）。 */
export function readNullableText(row: SqliteRow, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`column ${column} is not TEXT`);
  }
  return value;
}
