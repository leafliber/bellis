import { createHash } from "node:crypto";
import { z } from "zod";
import { MemoryPolicyStampSchema, MemoryRecallRequestSchema, UuidSchema } from "@bellis/contracts";
import { PersistenceError } from "../errors.js";
import { assertMemoryPolicy } from "./phase4-memory-policy.js";
import { readInt, readText, type SqliteDatabase } from "./sqlite-port.js";

export const RecallRequestWriteSchema = z.strictObject({
  policy: MemoryPolicyStampSchema,
  providerId: z.string().min(1).max(128),
  sessionId: UuidSchema,
  request: MemoryRecallRequestSchema,
});
export type RecallRequestWrite = z.infer<typeof RecallRequestWriteSchema>;

export function recordRecallRequest(
  db: SqliteDatabase,
  input: RecallRequestWrite,
  admit: () => void,
): void {
  const text = JSON.stringify(input),
    bytes = Buffer.byteLength(text);
  if (bytes > 65536) throw new PersistenceError("invalid_request", "Recall request exceeds 64 KiB");
  const digest = createHash("sha256").update(text).digest("hex");
  db.exec("BEGIN IMMEDIATE");
  try {
    assertMemoryPolicy(db, input.policy);
    const scope = db
      .prepare("SELECT scope_key FROM phase4_memory_session_scopes WHERE session_id=?")
      .get(input.sessionId);
    if (scope?.scope_key !== input.policy.scopeKey)
      throw new PersistenceError("invalid_request", "Recall request Session scope mismatch");
    const previous = db
      .prepare("SELECT request_json, request_digest FROM phase4_recall_requests WHERE attempt_id=?")
      .get(input.request.attemptId);
    if (previous !== undefined) {
      if (
        readText(previous, "request_digest") !== digest ||
        readText(previous, "request_json") !== text
      )
        throw new PersistenceError("idempotency_conflict", "Recall attempt identity conflict");
    } else {
      admit();
      const total = db
        .prepare(
          "SELECT COUNT(*) AS n, COALESCE(SUM(request_bytes),0) AS bytes FROM phase4_recall_requests",
        )
        .get()!;
      if (readInt(total, "n") >= 4096 || readInt(total, "bytes") + bytes > 64 * 1024 ** 2)
        throw new PersistenceError("database_busy", "Recall request storage capacity reached");
      db.prepare("INSERT INTO phase4_recall_requests VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        input.request.attemptId,
        input.policy.scopeKey,
        input.providerId,
        input.sessionId,
        text,
        digest,
        bytes,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
