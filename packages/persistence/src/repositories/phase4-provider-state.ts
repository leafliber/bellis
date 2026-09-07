import { createHash } from "node:crypto";
import { JsonValueSchema, type JsonValue } from "@bellis/contracts";
import { PersistenceError } from "../errors.js";
import { readInt, readText, type SqliteDatabase } from "./sqlite-port.js";

export interface ProviderStateScope {
  readonly scopeKey: string;
  readonly providerId: string;
}
export interface ProviderStateWrite extends ProviderStateScope {
  readonly expectedRevision: number;
  readonly state: JsonValue;
}
export interface ProviderStateSnapshot {
  readonly revision: number;
  readonly state: JsonValue;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function readProviderState(
  db: SqliteDatabase,
  scope: ProviderStateScope,
): ProviderStateSnapshot | null {
  const row = db
    .prepare("SELECT * FROM phase4_provider_state WHERE scope_key = ? AND provider_id = ?")
    .get(scope.scopeKey, scope.providerId);
  if (row === undefined) return null;
  const text = readText(row, "state_json");
  if (
    Buffer.byteLength(text) !== readInt(row, "state_bytes") ||
    hash(text) !== readText(row, "state_digest")
  )
    throw new PersistenceError("record_invalid", "provider state integrity check failed");
  return { revision: readInt(row, "revision"), state: JsonValueSchema.parse(JSON.parse(text)) };
}

export function writeProviderState(db: SqliteDatabase, input: ProviderStateWrite): number {
  const text = JSON.stringify(input.state);
  const bytes = Buffer.byteLength(text);
  if (bytes > 262_144)
    throw new PersistenceError("invalid_request", "provider state exceeds 256KiB");
  const digest = hash(text);
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db
      .prepare(
        "SELECT revision, state_digest, state_bytes FROM phase4_provider_state WHERE scope_key = ? AND provider_id = ?",
      )
      .get(input.scopeKey, input.providerId);
    const previous = existing === undefined ? 0 : readInt(existing, "revision");
    if (previous !== input.expectedRevision) {
      // Lost RPC acknowledgment: replaying the same write is safe only at its exact successor.
      if (
        existing !== undefined &&
        previous === input.expectedRevision + 1 &&
        readText(existing, "state_digest") === digest
      ) {
        db.exec("COMMIT");
        return previous;
      }
      throw new PersistenceError("idempotency_conflict", "provider state revision conflict");
    }
    const totals = db
      .prepare(
        "SELECT COUNT(*) AS rows, COALESCE(SUM(state_bytes), 0) AS bytes FROM phase4_provider_state",
      )
      .get()!;
    if (
      (existing === undefined && readInt(totals, "rows") >= 128) ||
      readInt(totals, "bytes") -
        (existing === undefined ? 0 : readInt(existing, "state_bytes")) +
        bytes >
        8_388_608
    )
      throw new PersistenceError("invalid_request", "provider state capacity exhausted");
    const revision = previous + 1;
    if (!Number.isSafeInteger(revision))
      throw new PersistenceError("invalid_request", "provider state revision exhausted");
    db.prepare(`INSERT INTO phase4_provider_state(scope_key, provider_id, revision, state_json, state_digest, state_bytes)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(scope_key, provider_id) DO UPDATE SET
      revision = excluded.revision, state_json = excluded.state_json, state_digest = excluded.state_digest, state_bytes = excluded.state_bytes`).run(
      input.scopeKey,
      input.providerId,
      revision,
      text,
      digest,
      bytes,
    );
    db.exec("COMMIT");
    return revision;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
