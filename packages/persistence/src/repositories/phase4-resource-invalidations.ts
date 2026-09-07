import { createHash } from "node:crypto";
import {
  MemoryResourceInvalidationSchema,
  type MemoryResourceInvalidation,
  type MemoryPolicySnapshot,
} from "@bellis/contracts";
import { PersistenceError } from "../errors.js";
import { readInt, readText, type SqliteDatabase } from "./sqlite-port.js";
import { readMemoryPolicy, changeMemoryPolicyInTransaction } from "./phase4-memory-policy.js";

export function applyResourceInvalidation(
  db: SqliteDatabase,
  input: { scopeKey: string; event: MemoryResourceInvalidation },
  nowMs: number,
): MemoryPolicySnapshot {
  const event = MemoryResourceInvalidationSchema.parse(input.event);
  const encoded = JSON.stringify(event);
  if (Buffer.byteLength(encoded) > 65_536)
    throw new PersistenceError("invalid_request", "resource invalidation exceeds capacity");
  const digest = createHash("sha256").update(encoded).digest("hex");
  db.exec("BEGIN IMMEDIATE");
  try {
    const previous = readMemoryPolicy(db, input.scopeKey);
    const existing = db
      .prepare(
        "SELECT event_digest FROM phase4_resource_invalidations WHERE scope_key = ? AND provider_id = ? AND event_id = ?",
      )
      .get(input.scopeKey, event.providerId, event.eventId);
    if (existing !== undefined) {
      if (readText(existing, "event_digest") !== digest)
        throw new PersistenceError("idempotency_conflict", "resource event replay changed");
      db.exec("COMMIT");
      return previous;
    }
    if (
      readInt(db.prepare("SELECT COUNT(*) AS n FROM phase4_resource_invalidations").get()!, "n") >=
      4096
    )
      throw new PersistenceError("database_busy", "resource event capacity reached");
    const identity = createHash("sha256")
      .update(JSON.stringify([input.scopeKey, event.providerId, event.eventId]))
      .digest("hex");
    const changeId = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-5${identity.slice(13, 16)}-a${identity.slice(17, 20)}-${identity.slice(20, 32)}`;
    const policy = changeMemoryPolicyInTransaction(
      db,
      {
        scopeKey: input.scopeKey,
        expectedGeneration: previous.generation,
        changeId,
        privacyRevision: previous.privacyRevision,
        blocked: previous.blocked,
        reason: "resource-invalidated",
        tombstones: event.resources.map((resource) => ({
          ...resource,
          providerId: event.providerId,
        })),
      },
      nowMs,
    );
    db.prepare("INSERT INTO phase4_resource_invalidations VALUES (?, ?, ?, ?, ?)").run(
      input.scopeKey,
      event.providerId,
      event.eventId,
      digest,
      event.cursor,
    );
    db.exec("COMMIT");
    return policy;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
