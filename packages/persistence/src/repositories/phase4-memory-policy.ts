import { createHash } from "node:crypto";
import { hasHistoryBarrier } from "./history-blocked.js";
import {
  MemoryPolicySnapshotSchema,
  isMemoryResourceBlocked,
  type MemoryPolicySnapshot,
  type MemoryPolicyStamp,
  type MemoryPolicyChange,
  type ContextManifest,
} from "@bellis/contracts";
import { PersistenceError } from "../errors.js";
import { readInt, readText, readNullableText, type SqliteDatabase } from "./sqlite-port.js";

const denied = () =>
  new PersistenceError("invalid_request", "memory privacy policy rejected operation");

export function readMemoryPolicy(db: SqliteDatabase, scopeKey: string): MemoryPolicySnapshot {
  const row = db.prepare("SELECT * FROM phase4_memory_policy WHERE scope_key = ?").get(scopeKey);
  if (row === undefined) throw denied();
  const historyBlocked = hasHistoryBarrier(db, scopeKey);
  return MemoryPolicySnapshotSchema.parse({
    scopeKey,
    generation: readInt(row, "generation"),
    privacyRevision: readText(row, "privacy_revision"),
    blocked: row.blocked === 1 || historyBlocked,
    ...(historyBlocked ? { historyBlocked: true } : {}),
    tombstones: db
      .prepare(
        "SELECT * FROM phase4_memory_tombstones WHERE scope_key = ? ORDER BY provider_id, resource_ref",
      )
      .all(scopeKey)
      .map((item) => ({
        providerId: readText(item, "provider_id"),
        resourceRef: readText(item, "resource_ref"),
        throughRevision: readNullableText(item, "through_revision"),
      })),
  });
}

export function ensureMemoryPolicy(
  db: SqliteDatabase,
  scopeKey: string,
  privacyRevision: string,
  sessionId?: string,
): MemoryPolicySnapshot {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (
      db.prepare("SELECT scope_key FROM phase4_memory_policy WHERE scope_key = ?").get(scopeKey) ===
      undefined
    ) {
      const row = db.prepare("SELECT COUNT(*) AS n FROM phase4_memory_policy").get()!;
      if (readInt(row, "n") >= 64)
        throw new PersistenceError("invalid_request", "memory policy capacity exhausted");
      db.prepare("INSERT INTO phase4_memory_policy VALUES (?, 0, ?, 0)").run(
        scopeKey,
        privacyRevision,
      );
    }
    const policy = readMemoryPolicy(db, scopeKey);
    if (policy.privacyRevision !== privacyRevision) throw denied();
    // Startup must reject a different scope before any provider opens. A blocked
    // policy may still restore its original binding so Forget/SSE recovery can run.
    if (sessionId !== undefined) {
      const previous = db
        .prepare("SELECT scope_key FROM phase4_memory_session_scopes WHERE session_id = ?")
        .get(sessionId);
      if (previous !== undefined && readText(previous, "scope_key") !== scopeKey) throw denied();
      db.prepare("INSERT OR IGNORE INTO phase4_memory_session_scopes VALUES (?, ?)").run(
        sessionId,
        scopeKey,
      );
    }
    db.exec("COMMIT");
    return policy;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function assertMemoryPolicy(
  db: SqliteDatabase,
  stamp: MemoryPolicyStamp,
  confirmedEffect = false,
): MemoryPolicySnapshot {
  const policy = readMemoryPolicy(db, stamp.scopeKey);
  // A verified effect already happened. Quarantine its observation during an
  // unknown-history pause, but never bypass an actual privacy block or revision.
  const blocked =
    confirmedEffect && policy.historyBlocked
      ? db
          .prepare("SELECT blocked FROM phase4_memory_policy WHERE scope_key = ?")
          .get(stamp.scopeKey)!.blocked === 1
      : policy.blocked;
  if (blocked || policy.generation !== stamp.generation) throw denied();
  return policy;
}

/** Caller owns the surrounding adoption/input transaction. A Session never changes identity scope. */
export function bindMemorySession(
  db: SqliteDatabase,
  sessionId: string,
  stamp?: MemoryPolicyStamp,
  confirmedEffect = false,
): void {
  const previous = db
    .prepare("SELECT scope_key FROM phase4_memory_session_scopes WHERE session_id = ?")
    .get(sessionId);
  if (stamp === undefined) {
    if (previous !== undefined) throw denied();
    return;
  }
  assertMemoryPolicy(db, stamp, confirmedEffect);
  if (previous !== undefined && readText(previous, "scope_key") !== stamp.scopeKey) throw denied();
  db.prepare("INSERT OR IGNORE INTO phase4_memory_session_scopes VALUES (?, ?)").run(
    sessionId,
    stamp.scopeKey,
  );
}

export function assertContextPolicy(
  db: SqliteDatabase,
  manifest: ContextManifest,
  confirmedEffect = false,
): void {
  if (manifest.policy === undefined) {
    if (
      db
        .prepare("SELECT scope_key FROM phase4_memory_session_scopes WHERE session_id = ?")
        .get(manifest.sessionId) !== undefined
    )
      throw denied();
    return;
  }
  const policy = assertMemoryPolicy(db, manifest.policy, confirmedEffect);
  if (policy.privacyRevision !== manifest.privacyRevision) throw denied();
  if (
    manifest.blocks.some(
      (block) =>
        block.result === "included" &&
        isMemoryResourceBlocked(
          policy.tombstones,
          block.providerId,
          block.sourceRefs,
          block.revision,
        ),
    )
  )
    throw denied();
  bindMemorySession(db, manifest.sessionId, manifest.policy, confirmedEffect);
}

export function changeMemoryPolicy(
  db: SqliteDatabase,
  input: MemoryPolicyChange,
  nowMs: number,
): MemoryPolicySnapshot {
  db.exec("BEGIN IMMEDIATE");
  try {
    const policy = changeMemoryPolicyInTransaction(db, input, nowMs);
    db.exec("COMMIT");
    return policy;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Caller owns the transaction, including any operation-specific barrier record. */
export function changeMemoryPolicyInTransaction(
  db: SqliteDatabase,
  input: MemoryPolicyChange,
  nowMs: number,
): MemoryPolicySnapshot {
  const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const existing = db
    .prepare("SELECT change_digest FROM phase4_memory_policy_changes WHERE change_id = ?")
    .get(input.changeId);
  if (existing !== undefined) {
    if (readText(existing, "change_digest") !== digest)
      throw new PersistenceError("idempotency_conflict", "memory policy change replay differs");
    const policy = readMemoryPolicy(db, input.scopeKey);
    return policy;
  }
  const previous = readMemoryPolicy(db, input.scopeKey);
  if (previous.generation !== input.expectedGeneration)
    throw new PersistenceError("idempotency_conflict", "memory policy generation conflict");
  const generation = previous.generation + 1;
  if (!Number.isSafeInteger(generation)) throw denied();
  if (
    new Set(input.tombstones.map((item) => JSON.stringify([item.providerId, item.resourceRef])))
      .size !== input.tombstones.length
  )
    throw denied();
  for (const item of input.tombstones) {
    const old = previous.tombstones.find(
      (entry) => entry.providerId === item.providerId && entry.resourceRef === item.resourceRef,
    );
    const through =
      old?.throughRevision === null || item.throughRevision === null
        ? null
        : old !== undefined && BigInt(old.throughRevision!) > BigInt(item.throughRevision)
          ? old.throughRevision
          : item.throughRevision;
    db.prepare(`INSERT INTO phase4_memory_tombstones VALUES (?, ?, ?, ?)
        ON CONFLICT(scope_key, provider_id, resource_ref) DO UPDATE SET through_revision = excluded.through_revision`).run(
      input.scopeKey,
      item.providerId,
      item.resourceRef,
      through,
    );
  }
  const size = db
    .prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(length(CAST(resource_ref AS BLOB))), 0) AS bytes FROM phase4_memory_tombstones WHERE scope_key = ?",
    )
    .get(input.scopeKey)!;
  if (readInt(size, "n") > 4096 || readInt(size, "bytes") > 4_194_304)
    throw new PersistenceError("invalid_request", "memory tombstone capacity exhausted");
  db.prepare(
    "UPDATE phase4_memory_policy SET generation = ?, privacy_revision = ?, blocked = ? WHERE scope_key = ?",
  ).run(generation, input.privacyRevision, input.blocked ? 1 : 0, input.scopeKey);
  db.prepare("INSERT INTO phase4_memory_policy_changes VALUES (?, ?, ?, ?, ?, ?)").run(
    input.changeId,
    input.scopeKey,
    digest,
    generation,
    input.reason,
    nowMs,
  );
  // Preserve immutable messages and distinguish already in-flight writes (unknown outcome).
  db.prepare(`INSERT OR IGNORE INTO phase4_memory_suppressed
      SELECT outbox_id, ?, ?, CASE WHEN status = 'in_flight' THEN 1 ELSE 0 END, ? FROM outbox
      WHERE topic IN ('memory.observe.v1', 'memory.usage.v1') AND status <> 'delivered'
        AND json_extract(payload_json, '$.policy.scopeKey') = ?`).run(
    input.scopeKey,
    generation,
    nowMs,
    input.scopeKey,
  );
  db.prepare(`UPDATE outbox SET status = 'dead', last_error_code = 'privacy_revoked', lease_until_ms = NULL,
      lease_owner_instance_id = NULL, updated_at_ms = ? WHERE outbox_id IN (
        SELECT outbox_id FROM phase4_memory_suppressed WHERE scope_key = ?)`).run(
    nowMs,
    input.scopeKey,
  );
  db.prepare(`UPDATE phase4_effect_preparations SET closed = 1, reserved_events = 0, reserved_bytes = 0
      WHERE EXISTS (SELECT 1 FROM phase4_context_manifests AS m WHERE m.session_id = phase4_effect_preparations.session_id
        AND m.cycle_id = phase4_effect_preparations.cycle_id AND json_extract(m.manifest_json, '$.policy.scopeKey') = ?)`).run(
    input.scopeKey,
  );
  // Closing by policy releases the same durable capacity as ordinary close.
  // No live Scene can lose its credits: both changes share this transaction.
  db.prepare(`DELETE FROM phase4_completion_reservations WHERE scene_id IN (
    SELECT scene_id FROM phase4_effect_preparations WHERE closed = 1)`).run();
  const policy = readMemoryPolicy(db, input.scopeKey);
  return policy;
}
