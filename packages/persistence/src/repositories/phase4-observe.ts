import { createHash, randomUUID } from "node:crypto";
import { MemoryInputObservationSchema } from "@bellis/contracts";
import { MemoryObserveEventSchema, type MemoryObserveEvent } from "@bellis/contracts/memory";
import type {
  MemoryInputObservation,
  MemoryOutputTarget,
  Signal,
  JsonValue,
} from "@bellis/contracts";
import { PersistenceError } from "../errors.js";
import { insertOutboxMessages } from "./outbox.js";
import { bindMemorySession } from "./phase4-memory-policy.js";
import { readText, type SqliteDatabase } from "./sqlite-port.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export function observationPressure(db: SqliteDatabase) {
  const pending = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(length(CAST(event_json AS BLOB))), 0) AS bytes FROM phase4_observations AS o
       WHERE ack_at_ms IS NULL AND NOT EXISTS (SELECT 1 FROM phase4_memory_suppressed AS s WHERE s.outbox_id = o.outbox_id)`,
    )
    .get()!;
  const reserved = db
    .prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(reserved_events), 0) AS events, COALESCE(SUM(reserved_bytes), 0) AS bytes FROM phase4_effect_preparations WHERE closed = 0",
    )
    .get()!;
  return {
    pendingCount: Number(pending.n),
    pendingBytes: Number(pending.bytes),
    reservedCount: Number(reserved.events),
    reservedBytes: Number(reserved.bytes),
    activePlans: Number(reserved.n),
  };
}

/** High watermark stops new adoption/input; already admitted effects own a
 * separate reservation below the hard 32MiB/11,024-event limit. */
export function assertMemoryAdmissionCapacity(
  db: SqliteDatabase,
  extraCount = 0,
  extraBytes = 0,
): void {
  const p = observationPressure(db);
  if (
    p.pendingCount + p.reservedCount + extraCount > 10_000 ||
    p.pendingBytes + p.reservedBytes + extraBytes > 16 * 1024 * 1024
  )
    throw new PersistenceError("database_busy", "memory observation capacity reached");
}

/** Caller owns the fact transaction and quota/reservation. Never call as a
 * detached asynchronous write. Each fact allocates one independent cursor. */
export function writeObservation(
  db: SqliteDatabase,
  input: {
    sessionId: string;
    factKey: string;
    target: MemoryOutputTarget;
    leaseNowMs: number;
    fact: {
      role: MemoryObserveEvent["role"];
      kind: string;
      occurredAtMs: number;
      committedAtMs: number;
      content: string;
      effectState: "committed" | "partial";
      actorExternalIdentityId?: string;
      effectProof?: Record<string, JsonValue>;
    };
  },
  confirmedEffect = false,
): void {
  const target = input.target;
  bindMemorySession(db, input.sessionId, target.policy, confirmedEffect);
  const key = [target.providerId, target.agentId, target.sourceStream] as const;
  const row = db
    .prepare(
      "SELECT allocated_cursor FROM phase4_observe_streams WHERE provider_id = ? AND agent_id = ? AND source_stream = ?",
    )
    .get(...key);
  const cursor = (row === undefined ? 0n : BigInt(readText(row, "allocated_cursor"))) + 1n;
  if (cursor > 999_999_999_999_999_999n)
    throw new PersistenceError("invalid_request", "observation cursor exhausted");
  const event = MemoryObserveEventSchema.parse({
    schemaVersion: 1,
    eventId: `bellis:${randomUUID()}`,
    outboxId: randomUUID(),
    agentId: target.agentId,
    spaceId: target.spaceId,
    ...(target.coreSessionId === undefined ? {} : { sessionId: target.coreSessionId }),
    ...input.fact,
    sourceStream: target.sourceStream,
    sourceCursor: cursor.toString(),
    privacyLabels: target.privacyLabels,
  });
  if (
    !Number.isSafeInteger(event.occurredAtMs * 1000) ||
    !Number.isSafeInteger(event.committedAtMs * 1000) ||
    event.occurredAtMs > event.committedAtMs ||
    (event.effectState === "partial"
      ? event.effectProof?.confirmed_range === undefined
      : event.effectProof !== undefined)
  )
    throw new PersistenceError("invalid_request", "invalid observation fact boundary");
  const encoded = JSON.stringify(event);
  insertOutboxMessages(
    db,
    input.sessionId,
    [
      {
        schemaVersion: 1,
        outboxId: event.outboxId,
        topic: "memory.observe.v1",
        partitionKey: hash(JSON.stringify(key)),
        payload: {
          providerId: target.providerId,
          event,
          ...(target.policy === undefined ? {} : { policy: target.policy }),
        },
        createdAtMs: event.committedAtMs,
      },
    ],
    event.committedAtMs,
    input.leaseNowMs,
  );
  db.prepare(`INSERT INTO phase4_observations
    (event_id, outbox_id, session_id, provider_id, agent_id, source_stream, source_cursor, fact_key, event_json, event_digest)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    event.eventId,
    event.outboxId,
    input.sessionId,
    ...key,
    cursor.toString(),
    input.factKey,
    encoded,
    hash(encoded),
  );
  db.prepare(`INSERT INTO phase4_observe_streams (provider_id, agent_id, source_stream, allocated_cursor)
    VALUES (?, ?, ?, ?) ON CONFLICT(provider_id, agent_id, source_stream)
    DO UPDATE SET allocated_cursor = excluded.allocated_cursor`).run(...key, cursor.toString());
}

/** Signal acceptance, its observation, and its cursor share a DB Worker transaction. */
export function enqueueInputObservations(
  db: SqliteDatabase,
  input: {
    sessionId: string;
    signal: Signal;
    observations: readonly MemoryInputObservation[];
    receivedAtMs: number;
    leaseNowMs: number;
  },
): void {
  if (input.observations.length === 0) return;
  if (
    input.observations.length > 8 ||
    new Set(input.observations.map((item) => item.providerId)).size !== input.observations.length
  )
    throw new PersistenceError("invalid_request", "invalid observation targets");
  const targets = input.observations.map((value) => MemoryInputObservationSchema.parse(value));
  assertMemoryAdmissionCapacity(
    db,
    targets.length,
    targets.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)) + 2048, 0),
  );
  for (const target of targets)
    writeObservation(db, {
      sessionId: input.sessionId,
      factKey: hash(JSON.stringify(["signal", input.signal.source, input.signal.id])),
      target,
      leaseNowMs: input.leaseNowMs,
      fact: {
        actorExternalIdentityId: target.actorExternalIdentityId,
        role: target.role,
        kind: input.signal.kind,
        occurredAtMs: input.signal.occurredAt,
        committedAtMs: input.receivedAtMs,
        effectState: "committed",
        content: target.content,
      },
    });
}
