import { parseDecimalString } from "@bellis/contracts";
import { PersistenceError } from "../errors.js";
import { readInt, readText } from "./sqlite-port.js";
import type { SqliteDatabase } from "./sqlite-port.js";

/**
 * sessions 表：Session 生命周期与服务端 Seq 水位（docs/protocols/persistence-and-recovery.md）。
 * latest_server_seq 以无损十进制 TEXT 存取，只允许前进。
 */

export function ensureSessionRow(
  db: SqliteDatabase,
  input: { sessionId: string; createdAtMs: number; nowMs: number },
): void {
  const existing = db
    .prepare("SELECT created_at_ms FROM sessions WHERE session_id = ?")
    .get(input.sessionId);
  if (existing !== undefined) {
    const stored = readInt(existing, "created_at_ms");
    if (stored !== input.createdAtMs) {
      throw new PersistenceError(
        "session_conflict",
        "session already exists with different metadata",
      );
    }
    return;
  }
  db.prepare(
    "INSERT INTO sessions (session_id, created_at_ms, latest_server_seq, updated_at_ms) VALUES (?, ?, '0', ?)",
  ).run(input.sessionId, input.createdAtMs, input.nowMs);
}

export function requireSessionRow(db: SqliteDatabase, sessionId: string): void {
  const row = db.prepare("SELECT 1 AS ok FROM sessions WHERE session_id = ?").get(sessionId);
  if (row === undefined) {
    throw new PersistenceError("session_not_found", `session does not exist`);
  }
}

export function readLatestServerSeq(db: SqliteDatabase, sessionId: string): bigint | null {
  const row = db
    .prepare("SELECT latest_server_seq FROM sessions WHERE session_id = ?")
    .get(sessionId);
  if (row === undefined) {
    return null;
  }
  return parseDecimalString(readText(row, "latest_server_seq"));
}

/** 单调推进服务端 Seq：相等幂等；倒退拒绝；返回落库后的当前值。 */
export function advanceServerSeq(
  db: SqliteDatabase,
  input: { sessionId: string; latestServerSeq: bigint; nowMs: number },
): bigint {
  const row = db
    .prepare("SELECT latest_server_seq FROM sessions WHERE session_id = ?")
    .get(input.sessionId);
  if (row === undefined) {
    throw new PersistenceError("session_not_found", `session does not exist`);
  }
  const current = parseDecimalString(readText(row, "latest_server_seq"));
  if (input.latestServerSeq < current) {
    throw new PersistenceError("seq_regression", "server seq can only move forward");
  }
  if (input.latestServerSeq > current) {
    db.prepare(
      "UPDATE sessions SET latest_server_seq = ?, updated_at_ms = ? WHERE session_id = ?",
    ).run(input.latestServerSeq.toString(10), input.nowMs, input.sessionId);
    return input.latestServerSeq;
  }
  return current;
}
