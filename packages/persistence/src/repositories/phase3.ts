import { parseDecimalString } from "@bellis/contracts";
import type { IngestedSignal, SessionRecord, Signal, SignalPriorityClass } from "@bellis/contracts";
import { PersistenceError } from "../errors.js";
import { appendSessionRecord, nextAggregateSeq } from "./session-records.js";
import { readText } from "./sqlite-port.js";
import type { SqliteDatabase } from "./sqlite-port.js";

/**
 * Phase 3 决策域仓库（ADR 0004 / phase-3-development-guide.md §9.3）。
 *
 * - 序号在 append 事务内分配（max+1，1 起、无缺口；单写 Worker 串行）；
 * - 去重以 (session_id, source, signal_id) 唯一索引承载：重复回显原序号；
 * - adoptCycle 是原子操作：cycle 行 + 消费水位 + Tool Run planned +
 *   session record 同事务，任一失败整体回滚；
 * - 非幂等 Tool 的 running 行恢复为 uncertain，绝不自动重试。
 */

export interface Phase3AppendSignalInput {
  readonly sessionId: string;
  readonly signal: Signal;
  readonly priorityClass: SignalPriorityClass;
  readonly receivedAtMs: number;
  readonly normalCapacity: number;
  readonly urgentCapacity: number;
}

export type Phase3AppendSignalOutcome =
  | { readonly result: "accepted"; readonly sequence: bigint }
  | { readonly result: "deduplicated"; readonly sequence: bigint }
  | { readonly result: "rejected"; readonly reason: "normal_capacity" | "urgent_capacity" };

function readConsumedWatermark(db: SqliteDatabase, sessionId: string): bigint {
  const row = db
    .prepare("SELECT consumed_watermark FROM phase3_decision_state WHERE session_id = ?")
    .get(sessionId);
  if (row === undefined) {
    return 0n;
  }
  return parseDecimalString(readText(row, "consumed_watermark"));
}

function advanceConsumedWatermark(
  db: SqliteDatabase,
  sessionId: string,
  watermark: bigint,
  nowMs: number,
): void {
  const current = readConsumedWatermark(db, sessionId);
  if (watermark < current) {
    throw new PersistenceError(
      "watermark_regression",
      `phase3 consumed watermark must not regress (current=${current}, got=${watermark})`,
    );
  }
  db.prepare(
    `INSERT INTO phase3_decision_state (session_id, consumed_watermark, updated_at_ms)
     VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET consumed_watermark = excluded.consumed_watermark, updated_at_ms = excluded.updated_at_ms`,
  ).run(sessionId, watermark.toString(10), nowMs);
}

/** Canonical decimal TEXT sorts numerically by length, then bytes; never cast through INTEGER/number. */
function lastAssignedSequence(db: SqliteDatabase, sessionId: string): bigint {
  const row = db
    .prepare(
      "SELECT sequence FROM phase3_signals WHERE session_id = ? ORDER BY length(sequence) DESC, sequence DESC LIMIT 1",
    )
    .get(sessionId);
  return row === undefined ? 0n : parseDecimalString(readText(row, "sequence"));
}

export function appendPhase3Signal(
  db: SqliteDatabase,
  input: Phase3AppendSignalInput,
): Phase3AppendSignalOutcome {
  const existing = db
    .prepare(
      "SELECT sequence FROM phase3_signals WHERE session_id = ? AND json_extract(signal_json, '$.source') = ? AND signal_id = ?",
    )
    .get(input.sessionId, input.signal.source, input.signal.id);
  if (existing !== undefined) {
    return { result: "deduplicated", sequence: parseDecimalString(readText(existing, "sequence")) };
  }
  const consumed = readConsumedWatermark(db, input.sessionId);
  const pendingRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM phase3_signals
       WHERE session_id = ?
         AND (length(sequence) > length(?) OR (length(sequence) = length(?) AND sequence > ?))
         AND priority_class = ?`,
    )
    .get(
      input.sessionId,
      consumed.toString(10),
      consumed.toString(10),
      consumed.toString(10),
      input.priorityClass,
    ) as { n: number } | undefined;
  const pendingCount = pendingRow?.n ?? 0;
  const capacity = input.priorityClass === "urgent" ? input.urgentCapacity : input.normalCapacity;
  if (pendingCount >= capacity) {
    return {
      result: "rejected",
      reason: input.priorityClass === "urgent" ? "urgent_capacity" : "normal_capacity",
    };
  }
  const next = lastAssignedSequence(db, input.sessionId) + 1n;
  db.prepare(
    `INSERT INTO phase3_signals (session_id, sequence, signal_id, priority_class, received_at_ms, signal_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.sessionId,
    next.toString(10),
    input.signal.id,
    input.priorityClass,
    input.receivedAtMs,
    JSON.stringify(input.signal),
  );
  return { result: "accepted", sequence: next };
}

export interface Phase3RestoreState {
  readonly pending: readonly IngestedSignal[];
  readonly lastAssigned: bigint;
  readonly consumed: bigint;
}

export function restorePhase3Signals(db: SqliteDatabase, sessionId: string): Phase3RestoreState {
  const consumed = readConsumedWatermark(db, sessionId);
  const rows = db
    .prepare(
      `SELECT sequence, signal_id, priority_class, received_at_ms, signal_json
       FROM phase3_signals WHERE session_id = ?
         AND (length(sequence) > length(?) OR (length(sequence) = length(?) AND sequence > ?))
       ORDER BY length(sequence) ASC, sequence ASC LIMIT 4096`,
    )
    .all(sessionId, consumed.toString(10), consumed.toString(10), consumed.toString(10));
  const pending: IngestedSignal[] = rows.map((row) => ({
    schemaVersion: 1,
    signalId: readText(row, "signal_id"),
    sequence: readText(row, "sequence"),
    priorityClass: readText(row, "priority_class") === "urgent" ? "urgent" : "normal",
    receivedAtMs: Number(row.received_at_ms),
    signal: JSON.parse(readText(row, "signal_json")) as Signal,
  }));
  return { pending, lastAssigned: lastAssignedSequence(db, sessionId), consumed };
}

export function markPhase3Consumed(
  db: SqliteDatabase,
  sessionId: string,
  watermark: bigint,
  nowMs: number,
): void {
  advanceConsumedWatermark(db, sessionId, watermark, nowMs);
}

export interface Phase3AdoptCycleInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly cycleId: string;
  readonly cycleIndex: number;
  readonly batchId: string;
  readonly watermarkFrom: bigint;
  readonly watermarkTo: bigint;
  readonly next: "finish" | "after_tools" | "continue";
  readonly degraded: boolean;
  readonly packetDigest: string;
  readonly traceId: string;
  readonly toolRuns: readonly {
    readonly toolRunId: string;
    readonly toolName: string;
    readonly idempotencyKeyHash: string | null;
  }[];
  readonly nowMs: number;
  readonly recordId: () => string;
}

/** Cycle adoption 原子事务：任一步失败整体回滚（ADR 0004 §4）。 */
export function adoptPhase3Cycle(db: SqliteDatabase, input: Phase3AdoptCycleInput): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db
      .prepare("SELECT adopted_at_ms FROM phase3_cycles WHERE session_id = ? AND cycle_id = ?")
      .get(input.sessionId, input.cycleId);
    if (existing !== undefined) {
      // 幂等重放：同一 cycleId 重复采用不重复推进（水位单调保护兜底）。
      db.exec("ROLLBACK");
      return;
    }
    db.prepare(
      `INSERT INTO phase3_cycles (session_id, cycle_id, turn_id, cycle_index, batch_id,
         watermark_from, watermark_to, next_action, degraded, packet_digest, adopted_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.sessionId,
      input.cycleId,
      input.turnId,
      input.cycleIndex,
      input.batchId,
      input.watermarkFrom.toString(10),
      input.watermarkTo.toString(10),
      input.next,
      input.degraded ? 1 : 0,
      input.packetDigest,
      input.nowMs,
    );
    for (const run of input.toolRuns) {
      db.prepare(
        `INSERT INTO phase3_tool_runs (session_id, tool_run_id, cycle_id, tool_name, state,
           idempotency_key_hash, started_at_ms, finished_at_ms)
         VALUES (?, ?, ?, ?, 'planned', ?, NULL, NULL)`,
      ).run(input.sessionId, run.toolRunId, input.cycleId, run.toolName, run.idempotencyKeyHash);
    }
    advanceConsumedWatermark(db, input.sessionId, input.watermarkTo, input.nowMs);
    const aggregateId = `cycle:${input.cycleId}`;
    const record: SessionRecord = {
      schemaVersion: 1,
      recordId: input.recordId(),
      sessionId: input.sessionId,
      recordType: "phase3_cycle_adopted",
      aggregateId,
      aggregateSeq: nextAggregateSeq(db, input.sessionId, aggregateId).toString(10),
      traceId: input.traceId,
      occurredAtMs: input.nowMs,
      payload: {
        payloadVersion: 1,
        turnId: input.turnId,
        cycleId: input.cycleId,
        cycleIndex: input.cycleIndex,
        batchId: input.batchId,
        watermarkFrom: input.watermarkFrom.toString(10),
        watermarkTo: input.watermarkTo.toString(10),
        next: input.next,
        degraded: input.degraded,
        toolRunIds: input.toolRuns.map((run) => run.toolRunId),
        packetDigest: input.packetDigest,
      },
    };
    appendSessionRecord(db, record);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export interface Phase3ToolRunEventInput {
  readonly sessionId: string;
  readonly toolRunId: string;
  readonly cycleId: string;
  readonly toolName: string;
  readonly transition: "started" | "finished";
  readonly state: string;
  readonly durationMs: number | null;
  readonly errorCode: string | null;
  readonly cacheSource: string | null;
  readonly resultSummaryJson: string | null;
  readonly nowMs: number;
}

export function recordPhase3ToolRunEvent(db: SqliteDatabase, input: Phase3ToolRunEventInput): void {
  if (input.transition === "started") {
    db.prepare(
      `INSERT INTO phase3_tool_runs (session_id, tool_run_id, cycle_id, tool_name, state, started_at_ms)
       VALUES (?, ?, ?, ?, 'running', ?)
       ON CONFLICT(session_id, tool_run_id) DO UPDATE SET state = 'running', started_at_ms = excluded.started_at_ms`,
    ).run(input.sessionId, input.toolRunId, input.cycleId, input.toolName, input.nowMs);
    return;
  }
  db.prepare(
    `INSERT INTO phase3_tool_runs (session_id, tool_run_id, cycle_id, tool_name, state,
       duration_ms, error_code, cache_source, result_summary_json, finished_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, tool_run_id) DO UPDATE SET
       state = excluded.state,
       duration_ms = excluded.duration_ms,
       error_code = excluded.error_code,
       cache_source = excluded.cache_source,
       result_summary_json = excluded.result_summary_json,
       finished_at_ms = excluded.finished_at_ms`,
  ).run(
    input.sessionId,
    input.toolRunId,
    input.cycleId,
    input.toolName,
    input.state,
    input.durationMs,
    input.errorCode,
    input.cacheSource,
    input.resultSummaryJson,
    input.nowMs,
  );
}

export interface Phase3ToolRunRow {
  readonly toolRunId: string;
  readonly cycleId: string;
  readonly toolName: string;
  readonly state: string;
  readonly idempotencyKeyHash: string | null;
  readonly cacheSource: string | null;
  readonly errorCode: string | null;
}

export interface Phase3CycleRow {
  readonly cycleId: string;
  readonly turnId: string;
  readonly cycleIndex: number;
  readonly watermarkTo: bigint;
  readonly degraded: boolean;
  readonly next: string;
}

export interface Phase3DecisionState {
  readonly consumed: bigint;
  readonly cycles: readonly Phase3CycleRow[];
  readonly toolRuns: readonly Phase3ToolRunRow[];
}

export function readPhase3DecisionState(
  db: SqliteDatabase,
  sessionId: string,
): Phase3DecisionState {
  const consumed = readConsumedWatermark(db, sessionId);
  const cycles = db
    .prepare(
      `SELECT cycle_id, turn_id, cycle_index, watermark_to, degraded, next_action
       FROM phase3_cycles WHERE session_id = ? ORDER BY adopted_at_ms ASC, cycle_id ASC LIMIT 512`,
    )
    .all(sessionId)
    .map((row) => ({
      cycleId: readText(row, "cycle_id"),
      turnId: readText(row, "turn_id"),
      cycleIndex: Number(row.cycle_index),
      watermarkTo: parseDecimalString(readText(row, "watermark_to")),
      degraded: Number(row.degraded) === 1,
      next: readText(row, "next_action"),
    }));
  const toolRuns = db
    .prepare(
      `SELECT tool_run_id, cycle_id, tool_name, state, idempotency_key_hash, cache_source, error_code
       FROM phase3_tool_runs WHERE session_id = ? LIMIT 4096`,
    )
    .all(sessionId)
    .map((row) => ({
      toolRunId: readText(row, "tool_run_id"),
      cycleId: readText(row, "cycle_id"),
      toolName: readText(row, "tool_name"),
      state: readText(row, "state"),
      idempotencyKeyHash:
        row.idempotency_key_hash === null ? null : readText(row, "idempotency_key_hash"),
      cacheSource: row.cache_source === null ? null : readText(row, "cache_source"),
      errorCode: row.error_code === null ? null : readText(row, "error_code"),
    }));
  return { consumed, cycles, toolRuns };
}

/** 恢复判定：非幂等 Tool 的 running → uncertain（绝不自动重试）。 */
export function markUncertainToolRuns(
  db: SqliteDatabase,
  sessionId: string,
  nowMs: number,
): number {
  const result = db
    .prepare(
      `UPDATE phase3_tool_runs SET state = 'uncertain', finished_at_ms = ?
       WHERE session_id = ? AND state = 'running'`,
    )
    .run(nowMs, sessionId);
  return Number(result.changes);
}

export function phase3ToolCacheGet(
  db: SqliteDatabase,
  cacheKey: string,
  nowMs: number,
): string | null {
  const row = db
    .prepare("SELECT payload_json, expires_at_ms FROM phase3_tool_cache WHERE cache_key = ?")
    .get(cacheKey);
  if (row === undefined) {
    return null;
  }
  if (Number(row.expires_at_ms) <= nowMs) {
    db.prepare("DELETE FROM phase3_tool_cache WHERE cache_key = ?").run(cacheKey);
    return null;
  }
  return readText(row, "payload_json");
}

export function phase3ToolCacheSet(
  db: SqliteDatabase,
  input: {
    readonly cacheKey: string;
    readonly toolName: string;
    readonly payloadJson: string;
    readonly ttlMs: number;
    readonly nowMs: number;
  },
): void {
  db.prepare(
    `INSERT INTO phase3_tool_cache (cache_key, tool_name, payload_json, created_at_ms, expires_at_ms)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       payload_json = excluded.payload_json,
       created_at_ms = excluded.created_at_ms,
       expires_at_ms = excluded.expires_at_ms`,
  ).run(input.cacheKey, input.toolName, input.payloadJson, input.nowMs, input.nowMs + input.ttlMs);
}
