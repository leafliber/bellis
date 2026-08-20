import { readInt, readText } from "./sqlite-port.js";
import type { SqliteDatabase } from "./sqlite-port.js";

/**
 * scenes 表：提交事实与版本化 Payload（P2 文档 §3.2、§7）。
 * commit_ordinal 在 commitScene 事务内按会话递增，是恢复排序依据；
 * committed_at_ms 仅审计。Payload 写入前已由操作层用 SceneSchema 校验。
 */

export interface SceneCommittedRow {
  readonly sceneId: string;
  readonly cycleId: string;
  readonly committedAtMs: number;
}

export function nextCommitOrdinal(db: SqliteDatabase, sessionId: string): number {
  const row = db
    .prepare("SELECT MAX(commit_ordinal) AS max_ordinal FROM scenes WHERE session_id = ?")
    .get(sessionId);
  const max = row?.["max_ordinal"];
  return max === null || max === undefined ? 1 : Number(max) + 1;
}

export function insertSceneRow(
  db: SqliteDatabase,
  input: {
    readonly sceneId: string;
    readonly cycleId: string;
    readonly sessionId: string;
    readonly commitOrdinal: number;
    readonly committedAtMs: number;
    readonly schemaVersion: number;
    readonly payloadJson: string;
    readonly idempotencyKey: string;
  },
): void {
  db.prepare(
    `INSERT INTO scenes
       (scene_id, cycle_id, session_id, status, commit_ordinal, committed_at_ms,
        schema_version, payload_json, idempotency_key)
     VALUES (?, ?, ?, 'committed', ?, ?, ?, ?, ?)`,
  ).run(
    input.sceneId,
    input.cycleId,
    input.sessionId,
    input.commitOrdinal,
    input.committedAtMs,
    input.schemaVersion,
    input.payloadJson,
    input.idempotencyKey,
  );
}

export function lastCommittedScene(
  db: SqliteDatabase,
  sessionId: string,
): SceneCommittedRow | null {
  const row = db
    .prepare(
      `SELECT scene_id, cycle_id, committed_at_ms FROM scenes
        WHERE session_id = ? ORDER BY commit_ordinal DESC LIMIT 1`,
    )
    .get(sessionId);
  if (row === undefined) {
    return null;
  }
  return {
    sceneId: readText(row, "scene_id"),
    cycleId: readText(row, "cycle_id"),
    committedAtMs: readInt(row, "committed_at_ms"),
  };
}
