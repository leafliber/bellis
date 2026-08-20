import { SessionRecordSchema, parseDecimalString } from "@bellis/contracts";
import type { SessionRecord } from "@bellis/contracts";
import { PersistenceError } from "../errors.js";
import { readInt, readNullableText, readText } from "./sqlite-port.js";
import type { SqliteDatabase, SqliteRow } from "./sqlite-port.js";

/**
 * session_records 表：Append-only 会话记录（P2 文档 §8.1）。
 *
 * - 写入前 SessionRecordSchema 校验（schemaVersion 由 Zod literal 闭合）。
 * - 读取后重校验；未知 schemaVersion → record_version_unknown。
 * - 同一 (session_id, aggregate_id) 的 aggregate_seq 单调且唯一：
 *   先显式比较（友好错误），唯一索引兜底并发。
 */

const KNOWN_RECORD_SCHEMA_VERSIONS = new Set([1]);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function rowToRecord(row: SqliteRow): SessionRecord {
  const schemaVersion = readInt(row, "schema_version");
  if (!KNOWN_RECORD_SCHEMA_VERSIONS.has(schemaVersion)) {
    throw new PersistenceError(
      "record_version_unknown",
      `session record schema version ${schemaVersion} is not supported by this build`,
    );
  }
  const parsed = SessionRecordSchema.safeParse({
    schemaVersion,
    recordId: readText(row, "record_id"),
    sessionId: readText(row, "session_id"),
    recordType: readText(row, "record_type"),
    aggregateId: readNullableText(row, "aggregate_id") ?? undefined,
    aggregateSeq: readNullableText(row, "aggregate_seq") ?? undefined,
    traceId: readText(row, "trace_id"),
    occurredAtMs: readInt(row, "occurred_at_ms"),
    payload: JSON.parse(readText(row, "payload_json")) as unknown,
  });
  if (!parsed.success) {
    throw new PersistenceError("internal", "stored session record failed schema validation");
  }
  return parsed.data;
}

export function appendSessionRecord(db: SqliteDatabase, record: SessionRecord): SessionRecord {
  const parsed = SessionRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new PersistenceError("record_invalid", "session record failed schema validation");
  }
  if (parsed.data.aggregateId !== undefined && parsed.data.aggregateSeq !== undefined) {
    const current = db
      .prepare(
        "SELECT MAX(aggregate_seq) AS max_seq FROM session_records WHERE session_id = ? AND aggregate_id = ?",
      )
      .get(parsed.data.sessionId, parsed.data.aggregateId);
    const maxSeq = readNullableText(current ?? {}, "max_seq");
    if (maxSeq !== null) {
      const next = parseDecimalString(parsed.data.aggregateSeq);
      if (next <= parseDecimalString(maxSeq)) {
        throw new PersistenceError("record_conflict", "aggregate seq must be strictly increasing");
      }
    }
  }
  try {
    db.prepare(
      `INSERT INTO session_records
         (record_id, session_id, record_type, aggregate_id, aggregate_seq,
          trace_id, occurred_at_ms, schema_version, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      parsed.data.recordId,
      parsed.data.sessionId,
      parsed.data.recordType,
      parsed.data.aggregateId ?? null,
      parsed.data.aggregateSeq ?? null,
      parsed.data.traceId,
      parsed.data.occurredAtMs,
      parsed.data.schemaVersion,
      JSON.stringify(parsed.data.payload),
    );
  } catch (error) {
    if (error instanceof PersistenceError) {
      throw error;
    }
    const message = String(error);
    if (message.includes("UNIQUE")) {
      throw new PersistenceError("record_conflict", "aggregate seq must be strictly increasing", {
        cause: error,
      });
    }
    if (message.includes("FOREIGN KEY")) {
      throw new PersistenceError("session_not_found", `session does not exist`, {
        cause: error,
      });
    }
    throw error;
  }
  return parsed.data;
}

export interface ListRecordsQuery {
  readonly sessionId?: string | undefined;
  readonly traceId?: string | undefined;
  readonly aggregateId?: string | undefined;
  readonly limit?: number | undefined;
}

export function listSessionRecords(db: SqliteDatabase, query: ListRecordsQuery): SessionRecord[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (query.sessionId !== undefined) {
    conditions.push("session_id = ?");
    params.push(query.sessionId);
  }
  if (query.traceId !== undefined) {
    conditions.push("trace_id = ?");
    params.push(query.traceId);
  }
  if (query.aggregateId !== undefined) {
    conditions.push("aggregate_id = ?");
    params.push(query.aggregateId);
  }
  const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT * FROM session_records${where} ORDER BY occurred_at_ms, record_id LIMIT ?`;
  return db
    .prepare(sql)
    .all(...params, limit)
    .map(rowToRecord);
}

/** commitScene 事务内读取指定聚合的下一个序号。 */
export function nextAggregateSeq(
  db: SqliteDatabase,
  sessionId: string,
  aggregateId: string,
): bigint {
  const row = db
    .prepare(
      "SELECT MAX(aggregate_seq) AS max_seq FROM session_records WHERE session_id = ? AND aggregate_id = ?",
    )
    .get(sessionId, aggregateId);
  const maxSeq = readNullableText(row ?? {}, "max_seq");
  return maxSeq === null ? 1n : parseDecimalString(maxSeq) + 1n;
}

export { rowToRecord };
