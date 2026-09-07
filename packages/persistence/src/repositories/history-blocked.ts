import type { SqliteDatabase } from "./sqlite-port.js";

export function historyBarrierTableExists(db: SqliteDatabase): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'phase4_history_gaps'")
      .get() !== undefined
  );
}

export function hasHistoryBarrier(db: SqliteDatabase, scopeKey: string): boolean {
  return (
    historyBarrierTableExists(db) &&
    db.prepare("SELECT 1 FROM phase4_history_gaps WHERE scope_key = ? LIMIT 1").get(scopeKey) !==
      undefined
  );
}
