import { createHash } from "node:crypto";
import { ToolCallSchema, type ToolCall } from "@bellis/contracts";
import { PersistenceError } from "../errors.js";
import { readInt, readText, type SqliteDatabase } from "./sqlite-port.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Original model call only. Trusted provider request resolution is a separate boundary. */
export interface PlannedToolCall {
  readonly toolRunId: string;
  readonly toolName: string;
  readonly idempotencyKeyHash: string | null;
  readonly originalCall?: ToolCall | undefined;
}

export function readToolCall(
  db: SqliteDatabase,
  input: { readonly sessionId: string; readonly toolRunId: string },
): ToolCall | null {
  const row = db
    .prepare(`SELECT c.*, r.tool_name, r.idempotency_key_hash
    FROM phase4_tool_calls c JOIN phase3_tool_runs r USING(session_id, tool_run_id)
    WHERE c.session_id = ? AND c.tool_run_id = ?`)
    .get(input.sessionId, input.toolRunId);
  if (row === undefined) return null;
  const text = readText(row, "call_json");
  if (
    Buffer.byteLength(text) !== readInt(row, "call_bytes") ||
    hash(text) !== readText(row, "call_digest")
  )
    throw new PersistenceError("record_invalid", "tool call integrity check failed");
  const call = ToolCallSchema.parse(JSON.parse(text));
  validateCall(call, {
    toolRunId: input.toolRunId,
    toolName: readText(row, "tool_name"),
    idempotencyKeyHash:
      row.idempotency_key_hash === null ? null : readText(row, "idempotency_key_hash"),
  });
  return call;
}

function validateCall(call: ToolCall, run: PlannedToolCall): void {
  if (
    call.toolRunId !== run.toolRunId ||
    call.toolName !== run.toolName ||
    (call.idempotencyKey === undefined ? null : hash(call.idempotencyKey)) !==
      run.idempotencyKeyHash
  )
    throw new PersistenceError("invalid_request", "tool call identity or key mismatch");
}

/** Called only inside the adoption transaction. Never evict unresolved calls to admit new work. */
export function insertToolCall(db: SqliteDatabase, sessionId: string, run: PlannedToolCall): void {
  if (run.originalCall === undefined) return; // Historical Phase 3 callers have no recoverable payload.
  const call = ToolCallSchema.parse(run.originalCall);
  validateCall(call, run);
  const text = JSON.stringify(call);
  const bytes = Buffer.byteLength(text);
  if (bytes > 65_536) throw new PersistenceError("invalid_request", "tool call exceeds 64KiB");
  const totals = db
    .prepare(
      "SELECT COUNT(*) AS rows, COALESCE(SUM(call_bytes), 0) AS bytes FROM phase4_tool_calls",
    )
    .get()!;
  if (readInt(totals, "rows") >= 4096 || readInt(totals, "bytes") + bytes > 8_388_608)
    throw new PersistenceError("invalid_request", "tool call capacity exhausted");
  db.prepare("INSERT INTO phase4_tool_calls VALUES (?, ?, ?, ?, ?)").run(
    sessionId,
    run.toolRunId,
    text,
    hash(text),
    bytes,
  );
}

/** Exact adoption retry must preserve the entire call set, including original keys and arguments. */
export function assertToolCallReplay(
  db: SqliteDatabase,
  sessionId: string,
  cycleId: string,
  runs: readonly PlannedToolCall[],
): void {
  const rows = db
    .prepare(
      "SELECT tool_run_id, tool_name, idempotency_key_hash FROM phase3_tool_runs WHERE session_id = ? AND cycle_id = ?",
    )
    .all(sessionId, cycleId);
  if (rows.length !== runs.length || new Set(runs.map((run) => run.toolRunId)).size !== runs.length)
    throw new PersistenceError("idempotency_conflict", "tool call replay set changed");
  for (const run of runs) {
    const row = rows.find((candidate) => candidate.tool_run_id === run.toolRunId);
    const stored = readToolCall(db, { sessionId, toolRunId: run.toolRunId });
    if (
      row === undefined ||
      row.tool_name !== run.toolName ||
      row.idempotency_key_hash !== run.idempotencyKeyHash ||
      JSON.stringify(stored) !==
        JSON.stringify(
          run.originalCall === undefined ? null : ToolCallSchema.parse(run.originalCall),
        )
    )
      throw new PersistenceError("idempotency_conflict", "tool call replay changed");
  }
}
