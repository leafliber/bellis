import { createHash } from "node:crypto";
import {
  MemoryForgetOperationSchema,
  MemoryForgetReceiptSchema,
  type MemoryForgetOperation,
  type MemoryForgetReceipt,
  type MemoryForgetTransition,
  type PreparedToolCall,
} from "@bellis/contracts";
import { PersistenceError } from "../errors.js";
import { readInt, readText, type SqliteDatabase } from "./sqlite-port.js";
import { readPreparedTool } from "./phase4-prepared-tools.js";
import {
  assertMemoryPolicy,
  changeMemoryPolicyInTransaction,
  readMemoryPolicy,
} from "./phase4-memory-policy.js";

type Identity = { readonly sessionId: string; readonly toolRunId: string };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const denied = () => new PersistenceError("invalid_request", "memory forget transition rejected");
function changeId(input: Identity, phase: string): string {
  const text = hash(JSON.stringify(["memory-forget", input.sessionId, input.toolRunId, phase]));
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-4${text.slice(13, 16)}-a${text.slice(17, 20)}-${text.slice(20, 32)}`;
}
function original(
  db: SqliteDatabase,
  input: Identity,
): PreparedToolCall & { policy: NonNullable<PreparedToolCall["policy"]> } {
  const prepared = readPreparedTool(db, input);
  if (
    prepared === null ||
    prepared.toolName !== "forget" ||
    prepared.policy === undefined ||
    prepared.resources.length === 0 ||
    prepared.idempotencyKey === null
  )
    throw denied();
  return prepared as PreparedToolCall & { policy: NonNullable<PreparedToolCall["policy"]> };
}
function validateReceipt(receipt: MemoryForgetReceipt): void {
  if (
    BigInt(receipt.erasedCount) + BigInt(receipt.protectedSkipped) + BigInt(receipt.heldSkipped) >
    BigInt(receipt.targetCount)
  )
    throw denied();
}
export function readMemoryForget(
  db: SqliteDatabase,
  input: Identity,
): MemoryForgetOperation | null {
  const row = db
    .prepare("SELECT * FROM phase4_memory_forget WHERE session_id = ? AND tool_run_id = ?")
    .get(input.sessionId, input.toolRunId);
  if (row === undefined) return null;
  const text = readText(row, "operation_json");
  if (hash(text) !== readText(row, "operation_digest")) throw denied();
  const operation = MemoryForgetOperationSchema.parse(JSON.parse(text));
  const prepared = original(db, input);
  if (
    operation.sessionId !== input.sessionId ||
    operation.toolRunId !== input.toolRunId ||
    operation.scopeKey !== prepared.policy.scopeKey ||
    operation.preparedDigest !== hash(JSON.stringify(prepared)) ||
    operation.barrierGeneration !== prepared.policy.generation + 1 ||
    (operation.state === "blocked") !== (operation.receipt === null)
  )
    throw denied();
  if (operation.receipt !== null) validateReceipt(operation.receipt);
  return operation;
}
function write(db: SqliteDatabase, operation: MemoryForgetOperation): void {
  const text = JSON.stringify(MemoryForgetOperationSchema.parse(operation));
  if (Buffer.byteLength(text) > 8192) throw denied();
  db.prepare(`INSERT INTO phase4_memory_forget VALUES (?, ?, ?, ?) ON CONFLICT(session_id, tool_run_id)
    DO UPDATE SET operation_json = excluded.operation_json, operation_digest = excluded.operation_digest`).run(
    operation.sessionId,
    operation.toolRunId,
    text,
    hash(text),
  );
}

/** Barrier ownership and privacy invalidation are one transaction, before remote dispatch. */
export function beginMemoryForget(
  db: SqliteDatabase,
  input: Identity,
  nowMs: number,
): MemoryForgetTransition {
  db.exec("BEGIN IMMEDIATE");
  try {
    const prepared = original(db, input);
    const existing = readMemoryForget(db, input);
    if (existing !== null) {
      const policy = readMemoryPolicy(db, existing.scopeKey);
      if (
        existing.state !== "blocked" ||
        !policy.blocked ||
        policy.generation !== existing.barrierGeneration
      )
        throw denied();
      db.exec("COMMIT");
      return { operation: existing, policy };
    }
    const size = db.prepare("SELECT COUNT(*) AS n FROM phase4_memory_forget").get()!;
    if (readInt(size, "n") >= 4096) throw denied();
    const previous = assertMemoryPolicy(db, prepared.policy);
    const policy = changeMemoryPolicyInTransaction(
      db,
      {
        scopeKey: previous.scopeKey,
        expectedGeneration: previous.generation,
        changeId: changeId(input, "begin"),
        privacyRevision: previous.privacyRevision,
        blocked: true,
        reason: "forget",
        tombstones: [],
      },
      nowMs,
    );
    const operation: MemoryForgetOperation = {
      ...input,
      scopeKey: previous.scopeKey,
      preparedDigest: hash(JSON.stringify(prepared)),
      barrierGeneration: policy.generation,
      state: "blocked",
      receipt: null,
    };
    write(db, operation);
    db.exec("COMMIT");
    return { operation, policy };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Receipt and tombstones are atomic. Completion cannot clear a newer privacy barrier. */
export function completeMemoryForget(
  db: SqliteDatabase,
  input: Identity & { receipt: MemoryForgetReceipt },
  nowMs: number,
): MemoryForgetTransition {
  const receipt = MemoryForgetReceiptSchema.parse(input.receipt);
  validateReceipt(receipt);
  db.exec("BEGIN IMMEDIATE");
  try {
    const prepared = original(db, input);
    const existing = readMemoryForget(db, input);
    if (existing === null) throw denied();
    const previous = readMemoryPolicy(db, existing.scopeKey);
    if (existing.receipt !== null) {
      if (JSON.stringify(existing.receipt) !== JSON.stringify(receipt))
        throw new PersistenceError("idempotency_conflict", "memory forget receipt changed");
      db.exec("COMMIT");
      return { operation: existing, policy: previous };
    }
    const resolved =
      receipt.erasedCount === receipt.targetCount &&
      receipt.heldSkipped === 0 &&
      receipt.protectedSkipped === 0;
    const ownsBarrier = previous.blocked && previous.generation === existing.barrierGeneration;
    const policy = changeMemoryPolicyInTransaction(
      db,
      {
        scopeKey: previous.scopeKey,
        expectedGeneration: previous.generation,
        changeId: changeId(input, "complete"),
        privacyRevision: previous.privacyRevision,
        blocked: resolved ? (ownsBarrier ? false : previous.blocked) : true,
        reason: "forget",
        tombstones: resolved
          ? prepared.resources.map((resource) => ({
              providerId: prepared.providerId,
              resourceRef: resource.ref.replace(/@[0-9]+$/, ""),
              throughRevision: null,
            }))
          : [],
      },
      nowMs,
    );
    const operation: MemoryForgetOperation = {
      ...existing,
      state: resolved ? "resolved" : "retained",
      receipt,
    };
    write(db, operation);
    db.exec("COMMIT");
    return { operation, policy };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
