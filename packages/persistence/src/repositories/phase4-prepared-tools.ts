import { createHash } from "node:crypto";
import {
  PreparedToolCallSchema,
  isMemoryResourceBlocked,
  type PreparedToolCall,
} from "@bellis/contracts";
import { PersistenceError } from "../errors.js";
import { readInt, readText, type SqliteDatabase } from "./sqlite-port.js";
import { readToolCall } from "./phase4-tool-calls.js";
import { assertMemoryPolicy, bindMemorySession } from "./phase4-memory-policy.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Historical read supports reconciliation even when execution is now privacy-blocked. */
export function readPreparedTool(
  db: SqliteDatabase,
  input: { sessionId: string; toolRunId: string },
): PreparedToolCall | null {
  const row = db
    .prepare("SELECT * FROM phase4_prepared_tools WHERE session_id = ? AND tool_run_id = ?")
    .get(input.sessionId, input.toolRunId);
  if (row === undefined) return null;
  const text = readText(row, "prepared_json");
  if (
    hash(text) !== readText(row, "prepared_digest") ||
    Buffer.byteLength(text) !== readInt(row, "prepared_bytes")
  )
    throw new PersistenceError("record_invalid", "prepared tool integrity check failed");
  const prepared = PreparedToolCallSchema.parse(JSON.parse(text));
  if (prepared.sessionId !== input.sessionId || prepared.toolRunId !== input.toolRunId)
    throw new PersistenceError("record_invalid", "prepared tool identity mismatch");
  assertOriginal(db, prepared);
  return prepared;
}

function assertOriginal(db: SqliteDatabase, input: PreparedToolCall): void {
  const original = readToolCall(db, input);
  const owner = db
    .prepare(`SELECT r.cycle_id, c.turn_id FROM phase3_tool_runs r JOIN phase3_cycles c
    USING(session_id, cycle_id) WHERE r.session_id = ? AND r.tool_run_id = ?`)
    .get(input.sessionId, input.toolRunId);
  if (
    original === null ||
    original.toolName !== input.toolName ||
    hash(JSON.stringify(original)) !== input.originalCallDigest ||
    owner?.cycle_id !== input.cycleId ||
    owner.turn_id !== input.turnId
  )
    throw new PersistenceError("invalid_request", "prepared tool original call mismatch");
}

/** Write once. Exact retry also revalidates current policy before a handler can execute. */
export function savePreparedTool(db: SqliteDatabase, value: PreparedToolCall): void {
  const input = PreparedToolCallSchema.parse(value);
  const text = JSON.stringify(input);
  const bytes = Buffer.byteLength(text);
  if (bytes > 65_536) throw new PersistenceError("invalid_request", "prepared tool exceeds 64KiB");
  db.exec("BEGIN IMMEDIATE");
  try {
    assertOriginal(db, input);
    bindMemorySession(db, input.sessionId, input.policy);
    if (input.policy !== undefined) {
      const policy = assertMemoryPolicy(db, input.policy);
      if (
        input.resources.some((resource) =>
          isMemoryResourceBlocked(
            policy.tombstones,
            input.providerId,
            [resource.ref],
            resource.revision,
          ),
        )
      )
        throw new PersistenceError("invalid_request", "prepared tool resource revoked");
    }
    const existing = readPreparedTool(db, input);
    if (existing !== null) {
      if (JSON.stringify(existing) !== text)
        throw new PersistenceError("idempotency_conflict", "prepared tool request changed");
      db.exec("COMMIT");
      return;
    }
    const totals = db
      .prepare(
        "SELECT COUNT(*) AS rows, COALESCE(SUM(prepared_bytes), 0) AS bytes FROM phase4_prepared_tools",
      )
      .get()!;
    if (readInt(totals, "rows") >= 4096 || readInt(totals, "bytes") + bytes > 8_388_608)
      throw new PersistenceError("invalid_request", "prepared tool capacity exhausted");
    db.prepare("INSERT INTO phase4_prepared_tools VALUES (?, ?, ?, ?, ?)").run(
      input.sessionId,
      input.toolRunId,
      text,
      hash(text),
      bytes,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
