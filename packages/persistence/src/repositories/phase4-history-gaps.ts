import { createHash } from "node:crypto";
import {
  MemoryHistoryGapSchema,
  type MemoryHistoryGap,
  type MemoryPolicySnapshot,
} from "@bellis/contracts";
import { PersistenceError } from "../errors.js";
import { readMemoryPolicy } from "./phase4-memory-policy.js";
import { readInt, readText, type SqliteDatabase } from "./sqlite-port.js";

export function beginHistoryGap(
  db: SqliteDatabase,
  input: { scopeKey: string; gap: MemoryHistoryGap },
  nowMs: number,
): MemoryPolicySnapshot {
  const gap = MemoryHistoryGapSchema.parse(input.gap);
  const encoded = JSON.stringify(gap);
  const digest = createHash("sha256").update(encoded).digest("hex");
  db.exec("BEGIN IMMEDIATE");
  try {
    readMemoryPolicy(db, input.scopeKey);
    const previous = db
      .prepare("SELECT gap_digest FROM phase4_history_gaps WHERE scope_key = ? AND provider_id = ?")
      .get(input.scopeKey, gap.providerId);
    if (previous !== undefined) {
      if (readText(previous, "gap_digest") !== digest)
        throw new PersistenceError("idempotency_conflict", "history gap replay changed");
    } else {
      if (readInt(db.prepare("SELECT count(*) AS n FROM phase4_history_gaps").get()!, "n") >= 512)
        throw new PersistenceError("database_busy", "history gap capacity reached");
      db.prepare("INSERT INTO phase4_history_gaps VALUES (?, ?, ?, ?, ?, ?)").run(
        input.scopeKey,
        gap.providerId,
        gap.gapId,
        digest,
        encoded,
        nowMs,
      );
    }
    const policy = readMemoryPolicy(db, input.scopeKey);
    db.exec("COMMIT");
    return policy;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
