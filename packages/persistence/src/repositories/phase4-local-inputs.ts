import {
  type LocalInputVisibilityRequest,
  type LocalInputVisibility,
  type MemoryPolicyStamp,
  isMemoryResourceBlocked,
} from "@bellis/contracts";
import { PersistenceError } from "../errors.js";
import { readText, type SqliteDatabase } from "./sqlite-port.js";
import { assertMemoryPolicy } from "./phase4-memory-policy.js";
import { readPhase4ContextManifest } from "./phase3.js";
import { readPreparedTool } from "./phase4-prepared-tools.js";

/** Single Worker operation observes one SQLite snapshot; it never authorizes by caller-supplied content. */
export function readLocalInputVisibility(
  db: SqliteDatabase,
  input: LocalInputVisibilityRequest,
): LocalInputVisibility {
  db.exec("BEGIN");
  try {
    const result = readSnapshot(db, input);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function readSnapshot(
  db: SqliteDatabase,
  input: LocalInputVisibilityRequest,
): LocalInputVisibility {
  const policy = assertMemoryPolicy(db, input.policy);
  const binding = db
    .prepare("SELECT scope_key FROM phase4_memory_session_scopes WHERE session_id = ?")
    .get(input.sessionId);
  if (binding !== undefined && readText(binding, "scope_key") !== policy.scopeKey)
    throw new PersistenceError("invalid_request", "local input session scope mismatch");
  const matches = (stamp: MemoryPolicyStamp | undefined) =>
    stamp?.scopeKey === policy.scopeKey && stamp.generation === policy.generation;
  let aggregatesVisible: boolean | undefined;
  if (input.batchRange !== undefined) {
    const { from, to } = input.batchRange;
    const count = BigInt(to) - BigInt(from) + 1n;
    aggregatesVisible = false;
    if (BigInt(from) >= 1n && count > 0n && count <= 16_384n) {
      const row = db
        .prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN p.scope_key = ? AND p.generation = ? THEN 1 ELSE 0 END) AS allowed
        FROM phase3_signals s LEFT JOIN phase4_signal_policy p USING(session_id, sequence)
        WHERE s.session_id = ?
          AND (length(s.sequence) > length(?) OR (length(s.sequence) = length(?) AND s.sequence >= ?))
          AND (length(s.sequence) < length(?) OR (length(s.sequence) = length(?) AND s.sequence <= ?))`)
        .get(policy.scopeKey, policy.generation, input.sessionId, from, from, from, to, to, to);
      aggregatesVisible = row?.total === Number(count) && row.allowed === Number(count);
    }
  }
  return {
    ...(aggregatesVisible === undefined ? {} : { aggregatesVisible }),
    signals: input.signalIds.map((signalId) => {
      const rows = db
        .prepare(`SELECT p.scope_key, p.generation FROM phase3_signals s
        LEFT JOIN phase4_signal_policy p USING(session_id, sequence)
        WHERE s.session_id = ? AND s.signal_id = ? LIMIT 2`)
        .all(input.sessionId, signalId);
      const row = rows.length === 1 ? rows[0] : undefined;
      const result =
        row?.scope_key == null
          ? "unbound"
          : row.scope_key === policy.scopeKey && row.generation === policy.generation
            ? "included"
            : "stale_policy";
      return { signalId, result };
    }),
    tools: input.toolRuns.map(({ toolRunId, toolName }) => {
      const run = db
        .prepare(
          "SELECT cycle_id, tool_name FROM phase3_tool_runs WHERE session_id = ? AND tool_run_id = ?",
        )
        .get(input.sessionId, toolRunId);
      if (run === undefined || run.tool_name !== toolName) return { toolRunId, result: "unbound" };
      const manifest = readPhase4ContextManifest(db, input.sessionId, readText(run, "cycle_id"));
      const stamp = manifest?.manifest.policy;
      if (stamp === undefined) return { toolRunId, result: "unbound" };
      if (!matches(stamp)) return { toolRunId, result: "stale_policy" };
      const prepared = readPreparedTool(db, { sessionId: input.sessionId, toolRunId });
      if (prepared !== null && !matches(prepared.policy))
        return { toolRunId, result: "stale_policy" };
      if (
        prepared?.resources.some((resource) =>
          isMemoryResourceBlocked(
            policy.tombstones,
            prepared.providerId,
            [resource.ref],
            resource.revision,
          ),
        )
      )
        return { toolRunId, result: "tombstone" };
      return { toolRunId, result: "included" };
    }),
  };
}
