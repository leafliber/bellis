import { parseDecimalString } from "@bellis/contracts";
import { PersistenceError } from "../errors.js";
import { readText } from "./sqlite-port.js";
import type { SqliteDatabase } from "./sqlite-port.js";

/**
 * signal_watermarks 表（P2 文档 §8.2）：
 * (session_id, source) 唯一；只允许前进（相等幂等，倒退拒绝）；
 * 比较在 bigint 域完成；多 Source 的推进与 commitScene 同事务。
 */

export interface WatermarkEntry {
  readonly source: string;
  readonly watermark: bigint;
}

export function advanceWatermarks(
  db: SqliteDatabase,
  sessionId: string,
  entries: readonly WatermarkEntry[],
  nowMs: number,
): void {
  for (const entry of entries) {
    const row = db
      .prepare("SELECT watermark FROM signal_watermarks WHERE session_id = ? AND source = ?")
      .get(sessionId, entry.source);
    if (row !== undefined) {
      const current = parseDecimalString(readText(row, "watermark"));
      if (entry.watermark < current) {
        throw new PersistenceError(
          "watermark_regression",
          `watermark for source ${entry.source} can only move forward`,
        );
      }
      if (entry.watermark > current) {
        db.prepare(
          "UPDATE signal_watermarks SET watermark = ?, updated_at_ms = ? WHERE session_id = ? AND source = ?",
        ).run(entry.watermark.toString(10), nowMs, sessionId, entry.source);
      }
      continue;
    }
    db.prepare(
      "INSERT INTO signal_watermarks (session_id, source, watermark, updated_at_ms) VALUES (?, ?, ?, ?)",
    ).run(sessionId, entry.source, entry.watermark.toString(10), nowMs);
  }
}

export function readWatermarks(db: SqliteDatabase, sessionId: string): WatermarkEntry[] {
  return db
    .prepare("SELECT source, watermark FROM signal_watermarks WHERE session_id = ? ORDER BY source")
    .all(sessionId)
    .map((row) => ({
      source: readText(row, "source"),
      watermark: parseDecimalString(readText(row, "watermark")),
    }));
}
