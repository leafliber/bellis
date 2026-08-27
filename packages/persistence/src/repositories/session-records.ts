import {
  SceneLifecyclePayloadSchema,
  SessionRecordSchema,
  parseDecimalString,
} from "@bellis/contracts";
import type { SessionRecord } from "@bellis/contracts";
import { PersistenceError } from "../errors.js";
import { readInt, readNullableText, readText } from "./sqlite-port.js";
import type { SqliteDatabase, SqliteRow } from "./sqlite-port.js";

/**
 * session_records 表：Append-only 会话记录（docs/protocols/persistence-and-recovery.md）。
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
  const aggregateId = readNullableText(row, "aggregate_id");
  const aggregateSeq = readNullableText(row, "aggregate_seq");
  // NULL 列不产生显式 undefined 键：响应要跨 postMessage/JSON 边界，
  // undefined 不是 JsonValue，会把整条响应判为非法（集成测试实测捕获）。
  const parsed = SessionRecordSchema.safeParse({
    schemaVersion,
    recordId: readText(row, "record_id"),
    sessionId: readText(row, "session_id"),
    recordType: readText(row, "record_type"),
    ...(aggregateId === null ? {} : { aggregateId }),
    ...(aggregateSeq === null ? {} : { aggregateSeq }),
    traceId: readText(row, "trace_id"),
    occurredAtMs: readInt(row, "occurred_at_ms"),
    payload: JSON.parse(readText(row, "payload_json")) as unknown,
  });
  if (!parsed.success) {
    throw new PersistenceError("internal", "stored session record failed schema validation");
  }
  return parsed.data;
}

/**
 * 读取聚合当前最大序号。
 * aggregate_seq 是十进制 TEXT，SQLite MAX()/ORDER BY 按字典序比较
 * （"9" > "10"）；规范十进制串的数值序 = (长度, 字典序)，必须显式
 * 按 LENGTH 再按值排序（评审阻断项：第 11 次 Scene Commit 因 MAX(TEXT)
 * 字典序误判而 record_conflict）。
 */
export function readMaxAggregateSeq(
  db: SqliteDatabase,
  sessionId: string,
  aggregateId: string,
): bigint | null {
  const row = db
    .prepare(
      `SELECT aggregate_seq FROM session_records
        WHERE session_id = ? AND aggregate_id = ?
        ORDER BY LENGTH(aggregate_seq) DESC, aggregate_seq DESC
        LIMIT 1`,
    )
    .get(sessionId, aggregateId);
  const maxSeq = readNullableText(row ?? {}, "aggregate_seq");
  return maxSeq === null ? null : parseDecimalString(maxSeq);
}

export function appendSessionRecord(db: SqliteDatabase, record: SessionRecord): SessionRecord {
  const parsed = SessionRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new PersistenceError("record_invalid", "session record failed schema validation");
  }
  if (parsed.data.aggregateId !== undefined && parsed.data.aggregateSeq !== undefined) {
    const maxSeq = readMaxAggregateSeq(db, parsed.data.sessionId, parsed.data.aggregateId);
    if (maxSeq !== null) {
      const next = parseDecimalString(parsed.data.aggregateSeq);
      if (next <= maxSeq) {
        throw new PersistenceError("record_conflict", "aggregate seq must be strictly increasing");
      }
    }
  }
  // Record 与活动 Scene 索引同事务落库：崩溃不会留下「记录在而索引缺」
  // 的半状态（该方向的失配会把未证终态 Scene 误判为已终态）。SAVEPOINT
  // 兼容外层事务（commitScene 等在既有事务内调用 appendRecord）；名称
  // 为静态常量（SQL 接口闭合，无拼接通道；本函数不自嵌套，同名栈安全）。
  db.exec("SAVEPOINT append_record_index");
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
    maintainActiveSceneIndex(db, parsed.data);
    db.exec("RELEASE append_record_index");
  } catch (error) {
    db.exec("ROLLBACK TO append_record_index");
    db.exec("RELEASE append_record_index");
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

/** 可证终态（DirectorInternalState 语义）：索引行删除。 */
const INDEX_TERMINAL_STATES = new Set(["completed", "cancelled", "failed"]);

/**
 * scene_lifecycle Record 的活动 Scene 索引维护（同事务调用）：
 * - 非终态转换 UPSERT（sceneId 取 payload 或 aggregateId 前缀）；
 * - 可证终态 DELETE；payload 不可解析/无版本时以 state='unknown' 保守
 *   保留（读取端按不可证终态处理，绝不静默当作已知格式）。
 */
function maintainActiveSceneIndex(
  db: SqliteDatabase,
  record: {
    sessionId: string;
    recordType: string;
    aggregateId?: string | undefined;
    occurredAtMs: number;
    payload: unknown;
  },
): void {
  if (record.recordType !== "scene_lifecycle") {
    return;
  }
  // payload 经版本化 Schema 校验后才可信（未知 payloadVersion/非法形态
  // 的 to 绝不当作已知状态——保守保留 unknown 行）。
  const parsed = SceneLifecyclePayloadSchema.safeParse(record.payload);
  const sceneId = parsed.success
    ? parsed.data.sceneId
    : sceneIdFromLifecycleAggregate(record.aggregateId);
  if (sceneId === null) {
    return;
  }
  const cycleId = parsed.success ? parsed.data.cycleId : null;
  const to = parsed.success ? parsed.data.to : "unknown";
  if (INDEX_TERMINAL_STATES.has(to)) {
    db.prepare(`DELETE FROM active_scenes WHERE session_id = ? AND scene_id = ?`).run(
      record.sessionId,
      sceneId,
    );
    return;
  }
  db.prepare(
    `INSERT INTO active_scenes (session_id, scene_id, cycle_id, state, updated_at_ms)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (session_id, scene_id) DO UPDATE SET
       cycle_id = excluded.cycle_id, state = excluded.state,
       updated_at_ms = excluded.updated_at_ms`,
  ).run(record.sessionId, sceneId, cycleId, to, record.occurredAtMs);
}

function sceneIdFromLifecycleAggregate(aggregateId: string | undefined): string | null {
  if (aggregateId === undefined || !aggregateId.startsWith("scene-lifecycle:")) {
    return null;
  }
  const sceneId = aggregateId.slice("scene-lifecycle:".length);
  return sceneId.length > 0 ? sceneId : null;
}

/**
 * 活动 Scene 索引查询（跨进程恢复的对账权威来源）。
 *
 * durable = scenes 表存在同 Session 的已提交行：committing 状态的歧义
 * （崩溃在 durable 前后）由它裁决——durable 的 committing 是「已提交但
 * 后续生命周期未落库」（按未证终态处理），非 durable 的 committing 是
 * 「提交从未生效」（Scene 从未存在，可安全忽略）。
 */
export interface ActiveSceneIndexRow {
  readonly sceneId: string;
  readonly cycleId: string | null;
  readonly state: string;
  readonly updatedAtMs: number;
  readonly durable: boolean;
}

export function listActiveScenes(db: SqliteDatabase, sessionId: string): ActiveSceneIndexRow[] {
  return db
    .prepare(
      `SELECT a.scene_id, a.cycle_id, a.state, a.updated_at_ms,
          CASE WHEN s.scene_id IS NULL THEN 0 ELSE 1 END AS durable
        FROM active_scenes a
        LEFT JOIN scenes s ON s.scene_id = a.scene_id AND s.session_id = a.session_id
        WHERE a.session_id = ?
        ORDER BY a.updated_at_ms, a.scene_id`,
    )
    .all(sessionId)
    .map((row) => {
      const record = row as Record<string, unknown>;
      return {
        sceneId: String(record["scene_id"]),
        cycleId:
          record["cycle_id"] === null || record["cycle_id"] === undefined
            ? null
            : String(record["cycle_id"]),
        state: String(record["state"]),
        updatedAtMs: Number(record["updated_at_ms"]),
        durable: Number(record["durable"]) === 1,
      };
    });
}

export interface ListRecordsQuery {
  readonly sessionId?: string | undefined;
  readonly traceId?: string | undefined;
  readonly aggregateId?: string | undefined;
  /** 按 recordType 过滤（如 scene_lifecycle 专用窗口）。 */
  readonly recordType?: string | undefined;
  /** 排序方向（默认 asc；desc 取最近窗口）。 */
  readonly order?: "asc" | "desc" | undefined;
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
  if (query.recordType !== undefined) {
    conditions.push("record_type = ?");
    params.push(query.recordType);
  }
  const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  const direction = query.order === "desc" ? " DESC" : "";
  const sql = `SELECT * FROM session_records${where} ORDER BY occurred_at_ms${direction}, record_id${direction} LIMIT ?`;
  return db
    .prepare(sql)
    .all(...params, limit)
    .map(rowToRecord);
}

/** commitScene 事务内读取指定聚合的下一个序号（长度+字典序，见 readMaxAggregateSeq）。 */
export function nextAggregateSeq(
  db: SqliteDatabase,
  sessionId: string,
  aggregateId: string,
): bigint {
  const maxSeq = readMaxAggregateSeq(db, sessionId, aggregateId);
  return maxSeq === null ? 1n : maxSeq + 1n;
}

export { rowToRecord };
