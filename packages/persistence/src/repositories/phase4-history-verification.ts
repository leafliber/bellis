import { createHash } from "node:crypto";
import { z } from "zod";
import { UuidSchema, type MemoryRecallRequest } from "@bellis/contracts";
import { PersistenceError } from "../errors.js";
import { readInt, readText, type SqliteDatabase, type SqliteRow } from "./sqlite-port.js";
import {
  HistoryInventoryPageSchema,
  withCurrentInventory,
  type HistoryInventory,
  type HistoryInventoryPageInput,
  type HistoryInventoryItemInput,
} from "./phase4-history-inventory.js";
import { RecallRequestWriteSchema } from "./phase4-recall-requests.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Result = z.strictObject({
  ordinal: z.number().int().min(1).max(4096),
  digest: Hash,
  requestId: z.string().min(1).max(256),
  status: z.enum(["valid", "unavailable"]),
});
/** Trusted verification evidence. Never a delivery ACK or permission to resume. */
export const HistoryVerificationBatchSchema = z
  .strictObject({
    batchId: UuidSchema,
    runId: UuidSchema,
    inventoryDigest: Hash,
    scheme: z.literal("recall-current-v1"),
    checkedAt: z.iso.datetime({ offset: true }),
    results: z.array(Result).min(1).max(16),
  })
  .superRefine((batch, ctx) => {
    if (
      new Set(batch.results.map((r) => r.ordinal)).size !== batch.results.length ||
      new Set(batch.results.map((r) => r.requestId)).size !== batch.results.length
    )
      ctx.addIssue({ code: "custom", message: "verification batch identities must be unique" });
  });
export type HistoryVerificationBatch = z.infer<typeof HistoryVerificationBatchSchema>;
export const HistoryVerificationPageSchema = HistoryInventoryPageSchema.extend({
  items: z
    .array(
      HistoryInventoryPageSchema.shape.items.element.extend({
        verification: z
          .strictObject({
            batchId: UuidSchema,
            scheme: z.literal("recall-current-v1"),
            checkedAt: z.iso.datetime({ offset: true }),
            requestId: Result.shape.requestId,
            status: Result.shape.status,
          })
          .nullable(),
      }),
    )
    .max(64),
});
export type HistoryVerificationPage = z.infer<typeof HistoryVerificationPageSchema>;
type SourceItem = { ordinal: number; kind: string; id: string; digest: string; body: string };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const invalid = () =>
  new PersistenceError("record_invalid", "history verification integrity check failed");
const conflict = () =>
  new PersistenceError("idempotency_conflict", "history verification binding conflict");

/** Transmission admission, unlike the broader inventory audit read. Older
 * preparation generations need explicit reauthorization and remain unchecked. */
export function readRevalidationRequest(
  db: SqliteDatabase,
  input: HistoryInventoryItemInput,
): MemoryRecallRequest | null {
  return withCurrentInventory(db, input.runId, (inventory, items) => {
    if (
      db
        .prepare("SELECT blocked FROM phase4_memory_policy WHERE scope_key=?")
        .get(inventory.scopeKey)?.blocked !== 0
    )
      throw new PersistenceError("invalid_request", "history revalidation privacy blocked");
    const item = items[input.ordinal - 1];
    if (item?.kind !== "recall_request")
      throw new PersistenceError("invalid_request", "original Recall request required");
    const prepared = RecallRequestWriteSchema.parse(JSON.parse(item.body));
    if (
      prepared.providerId !== inventory.providerId ||
      prepared.policy.scopeKey !== inventory.scopeKey ||
      prepared.request.attemptId !== item.id
    )
      throw invalid();
    if (prepared.policy.generation !== inventory.generation) return null;
    return prepared.request;
  });
}

function assertBatchMembership(db: SqliteDatabase, runId: string) {
  // Missing links must not turn a recorded verdict into an unchecked item that
  // a different batch could overwrite. Check even an empty/end page.
  const damaged = db
    .prepare(`SELECT b.batch_id
    FROM phase4_history_verification_batches b
    LEFT JOIN phase4_history_verification_items i USING(run_id, batch_id)
    WHERE b.run_id=? GROUP BY b.batch_id, b.batch_json
    HAVING count(i.ordinal) != json_array_length(b.batch_json, '$.results') LIMIT 1`)
    .get(runId);
  if (damaged !== undefined) throw invalid();
}

function assertBinding(
  batch: HistoryVerificationBatch,
  inventory: HistoryInventory,
  items: SourceItem[],
) {
  if (batch.runId !== inventory.runId || batch.inventoryDigest !== inventory.inventoryDigest)
    throw conflict();
  for (const result of batch.results) {
    const item = items[result.ordinal - 1];
    if (item?.kind !== "recall_request" || item.digest !== result.digest) throw conflict();
    const prepared = RecallRequestWriteSchema.parse(JSON.parse(item.body));
    if (
      prepared.request.requestId !== result.requestId ||
      prepared.request.attemptId !== item.id ||
      prepared.policy.scopeKey !== inventory.scopeKey ||
      prepared.providerId !== inventory.providerId
    )
      throw conflict();
  }
}

function readBatch(
  db: SqliteDatabase,
  row: SqliteRow,
  inventory: HistoryInventory,
  items: SourceItem[],
) {
  const text = readText(row, "batch_json");
  if (Buffer.byteLength(text) > 16384 || hash(text) !== readText(row, "batch_digest"))
    throw invalid();
  const parsed = HistoryVerificationBatchSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw invalid();
  const batch = parsed.data;
  if (batch.batchId !== row.batch_id || batch.runId !== row.run_id) throw invalid();
  assertBinding(batch, inventory, items);
  const bindings = db
    .prepare(
      "SELECT run_id, ordinal FROM phase4_history_verification_items WHERE batch_id=? ORDER BY ordinal",
    )
    .all(batch.batchId);
  const ordinals = batch.results.map((r) => r.ordinal).toSorted((a, b) => a - b);
  if (
    bindings.length !== ordinals.length ||
    bindings.some((b, i) => b.run_id !== batch.runId || readInt(b, "ordinal") !== ordinals[i])
  )
    throw invalid();
  return batch;
}

export function recordHistoryVerification(
  db: SqliteDatabase,
  input: HistoryVerificationBatch,
  admit: () => void,
): void {
  const text = JSON.stringify(input);
  if (Buffer.byteLength(text) > 16384)
    throw new PersistenceError("invalid_request", "history verification batch exceeds 16 KiB");
  withCurrentInventory(
    db,
    input.runId,
    (inventory, items) => {
      assertBatchMembership(db, input.runId);
      assertBinding(input, inventory, items);
      const existing = db
        .prepare("SELECT * FROM phase4_history_verification_batches WHERE batch_id=?")
        .get(input.batchId);
      if (existing !== undefined) {
        readBatch(db, existing, inventory, items);
        if (readText(existing, "batch_json") !== text) throw conflict();
        return;
      }
      for (const result of input.results) {
        if (
          db
            .prepare(
              "SELECT batch_id FROM phase4_history_verification_items WHERE run_id=? AND ordinal=?",
            )
            .get(input.runId, result.ordinal) !== undefined
        )
          throw conflict();
      }
      admit();
      db.prepare("INSERT INTO phase4_history_verification_batches VALUES (?, ?, ?, ?)").run(
        input.batchId,
        input.runId,
        text,
        hash(text),
      );
      const insert = db.prepare("INSERT INTO phase4_history_verification_items VALUES (?, ?, ?)");
      for (const result of input.results) insert.run(input.runId, result.ordinal, input.batchId);
    },
    "write",
  );
}

export function readHistoryVerificationPage(
  db: SqliteDatabase,
  input: HistoryInventoryPageInput,
): HistoryVerificationPage {
  return withCurrentInventory(db, input.runId, (inventory, items) => {
    assertBatchMembership(db, input.runId);
    if (input.after > inventory.itemCount)
      throw new PersistenceError(
        "invalid_request",
        "history verification cursor exceeds item count",
      );
    const cache = new Map<string, HistoryVerificationBatch>();
    const selected = items
      .slice(input.after, input.after + input.limit)
      .map(({ body: _body, ...item }) => {
        const binding = db
          .prepare(
            "SELECT batch_id FROM phase4_history_verification_items WHERE run_id=? AND ordinal=?",
          )
          .get(input.runId, item.ordinal);
        if (binding === undefined) return { ...item, verification: null };
        const batchId = readText(binding, "batch_id");
        let batch = cache.get(batchId);
        if (batch === undefined) {
          const row = db
            .prepare("SELECT * FROM phase4_history_verification_batches WHERE batch_id=?")
            .get(batchId);
          if (row === undefined) throw invalid();
          batch = readBatch(db, row, inventory, items);
          cache.set(batchId, batch);
        }
        const result = batch.results.find((r) => r.ordinal === item.ordinal);
        if (result === undefined) throw invalid();
        return {
          ...item,
          verification: {
            batchId,
            scheme: batch.scheme,
            checkedAt: batch.checkedAt,
            requestId: result.requestId,
            status: result.status,
          },
        };
      });
    return HistoryVerificationPageSchema.parse({
      inventory,
      items: selected,
      done: input.after + selected.length === items.length,
    });
  });
}
