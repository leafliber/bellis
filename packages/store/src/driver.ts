import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite 驱动接口（R-04）。状态存储只经过这一层访问数据库，将来更换驱动只需实现这里。
 * 参数一律用位置占位符 `?`。
 */
export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, SqlValue>;

export interface Statement {
  run(...params: SqlValue[]): { changes: number | bigint };
  get(...params: SqlValue[]): Row | undefined;
  all(...params: SqlValue[]): Row[];
}

export interface Driver {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  readonly inTransaction: boolean;
  close(): void;
}

/**
 * 用 Node 内置的 `node:sqlite` 打开数据库（稳定度 1.2，升级 Node 时复核）。
 * WAL 日志；synchronous=FULL，保证意图在执行副作用之前已经落盘。
 */
export function openSqlite(path: string): Driver {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return {
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        run: (...params) => statement.run(...params),
        get: (...params) => statement.get(...params) as Row | undefined,
        all: (...params) => statement.all(...params) as Row[],
      };
    },
    get inTransaction() {
      return db.isTransaction;
    },
    close: () => db.close(),
  };
}
