import { createHash } from "node:crypto";
import { z } from "zod";
import {
  JsonValueSchema,
  MemoryPolicyStampSchema,
  MemoryPolicySnapshotSchema,
  MemoryHistoryGapSchema,
  UuidSchema,
} from "@bellis/contracts";
import { PersistenceError } from "../errors.js";
import { readMemoryPolicy } from "./phase4-memory-policy.js";
import { readInt, readText, type SqliteDatabase } from "./sqlite-port.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_ITEMS = 4096;
const MAX_BYTES = 64 * 1024 ** 2;
export const HistoryInventoryBeginSchema = z.strictObject({
  runId: UuidSchema,
  scopeKey: MemoryPolicyStampSchema.shape.scopeKey,
  providerId: z.string().min(1).max(128),
  gapId: Hash,
  generation: MemoryPolicyStampSchema.shape.generation,
});
export type HistoryInventoryBegin = z.infer<typeof HistoryInventoryBeginSchema>;
export const HistoryInventorySchema = HistoryInventoryBeginSchema.extend({
  itemCount: z.number().int().min(0).max(MAX_ITEMS),
  contentBytes: z.number().int().min(0).max(MAX_BYTES),
  inventoryDigest: Hash,
});
export type HistoryInventory = z.infer<typeof HistoryInventorySchema>;
export const HistoryInventoryPageInputSchema = z.strictObject({
  runId: UuidSchema,
  after: z.number().int().min(0).max(MAX_ITEMS),
  limit: z.number().int().min(1).max(64),
});
export type HistoryInventoryPageInput = z.infer<typeof HistoryInventoryPageInputSchema>;
const ItemSchema = z.strictObject({
  ordinal: z.number().int().min(1).max(MAX_ITEMS),
  kind: z.enum(["manifest", "observation", "usage", "effect", "provider_state", "recall_request"]),
  id: z.string().min(1).max(256),
  digest: Hash,
});
export const HistoryInventoryPageSchema = z.strictObject({
  inventory: HistoryInventorySchema,
  items: z.array(ItemSchema).max(64),
  done: z.boolean(),
});
export type HistoryInventoryPage = z.infer<typeof HistoryInventoryPageSchema>;
export const HistoryInventoryItemInputSchema = z.strictObject({
  runId: UuidSchema,
  ordinal: z.number().int().min(1).max(MAX_ITEMS),
});
export type HistoryInventoryItemInput = z.infer<typeof HistoryInventoryItemInputSchema>;
export const HistoryInventoryItemSchema = ItemSchema.extend({ body: JsonValueSchema });
export type HistoryInventoryItem = z.infer<typeof HistoryInventoryItemSchema>;

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const stale = () =>
  new PersistenceError("idempotency_conflict", "history inventory changed; rebuild required");
// All old contexts/confirmed effects participate because they can enter future
// shared Context. Remote delivery identities are specific to the gap provider.
const SOURCE = `
SELECT 'manifest' AS kind, m.manifest_id AS id, m.manifest_json AS body, m.manifest_json AS checked_body, m.manifest_digest AS expected_digest
FROM phase4_context_manifests m JOIN phase4_memory_session_scopes s USING(session_id)
WHERE s.scope_key = ?
UNION ALL
SELECT 'observation', o.event_id, json_object('event', json(o.event_json), 'outboxId', b.outbox_id, 'payload', json(b.payload_json), 'status', b.status, 'ackAtMs', o.ack_at_ms), o.event_json, o.event_digest
FROM phase4_observations o JOIN outbox b USING(outbox_id)
JOIN phase4_memory_session_scopes s ON s.session_id = o.session_id
WHERE s.scope_key = ? AND o.provider_id = ?
UNION ALL
SELECT 'usage', b.outbox_id, json_object('payload', json(b.payload_json), 'status', b.status), NULL, NULL
FROM outbox b JOIN phase4_memory_session_scopes s USING(session_id)
WHERE s.scope_key = ? AND b.topic = 'memory.usage.v1' AND json_extract(b.payload_json, '$.providerId') = ?
UNION ALL
SELECT 'effect', r.receipt_id, json_object('receipt', json(r.receipt_json), 'text', r.confirmed_text, 'confirmedAtMs', r.confirmed_at_ms), r.receipt_json, r.receipt_digest
FROM phase4_effect_receipts r JOIN phase4_memory_session_scopes s USING(session_id)
WHERE s.scope_key = ?
UNION ALL
SELECT 'provider_state', provider_id, state_json, state_json, state_digest
FROM phase4_provider_state WHERE scope_key = ? AND provider_id = ?
UNION ALL
SELECT 'recall_request', attempt_id, request_json, request_json, request_digest
FROM phase4_recall_requests WHERE scope_key = ? AND provider_id = ?`;

function collect(db: SqliteDatabase, input: HistoryInventoryBegin) {
  const args = [
    input.scopeKey,
    input.scopeKey,
    input.providerId,
    input.scopeKey,
    input.providerId,
    input.scopeKey,
    input.scopeKey,
    input.providerId,
  ];
  args.push(input.scopeKey, input.providerId);
  const size = db
    .prepare(
      `SELECT count(*) AS n, coalesce(sum(length(CAST(body AS BLOB))), 0) AS bytes FROM (${SOURCE})`,
    )
    .get(...args)!;
  const itemCount = readInt(size, "n"),
    contentBytes = readInt(size, "bytes");
  if (itemCount > MAX_ITEMS || contentBytes > MAX_BYTES)
    throw new PersistenceError("database_busy", "history inventory capacity reached");
  const rows = db.prepare(`SELECT * FROM (${SOURCE}) ORDER BY kind, id`).all(...args);
  for (const row of rows) {
    if (
      row.expected_digest !== null &&
      hash(readText(row, "checked_body")) !== readText(row, "expected_digest")
    )
      throw new PersistenceError("record_invalid", "history source integrity check failed");
  }
  const items = rows.map((row, index) => ({
    ordinal: index + 1,
    kind: readText(row, "kind"),
    id: readText(row, "id"),
    digest: hash(readText(row, "body")),
    body: readText(row, "body"),
  }));
  const inventoryDigest = hash(JSON.stringify(items.map(({ body: _body, ...item }) => item)));
  return { items, itemCount, contentBytes, inventoryDigest };
}

function assertGap(db: SqliteDatabase, input: HistoryInventoryBegin) {
  const policy = readMemoryPolicy(db, input.scopeKey);
  const gap = db
    .prepare("SELECT gap_id FROM phase4_history_gaps WHERE scope_key = ? AND provider_id = ?")
    .get(input.scopeKey, input.providerId);
  if (policy.generation !== input.generation || gap?.gap_id !== input.gapId) throw stale();
}

function readRun(db: SqliteDatabase, runId: string): HistoryInventory {
  const row = db.prepare("SELECT * FROM phase4_history_inventories WHERE run_id = ?").get(runId);
  if (row === undefined)
    throw new PersistenceError("invalid_request", "history inventory not found");
  const inventory = HistoryInventorySchema.parse(JSON.parse(readText(row, "inventory_json")));
  if (
    inventory.runId !== runId ||
    inventory.scopeKey !== row.scope_key ||
    inventory.providerId !== row.provider_id
  )
    throw new PersistenceError("record_invalid", "history inventory identity check failed");
  return inventory;
}

/** The inventory is a coverage obligation, never authority to release a gap. */
export function beginHistoryInventory(
  db: SqliteDatabase,
  input: HistoryInventoryBegin,
): HistoryInventory {
  db.exec("BEGIN IMMEDIATE");
  try {
    assertGap(db, input);
    const collected = collect(db, input);
    const inventory = HistoryInventorySchema.parse({
      ...input,
      itemCount: collected.itemCount,
      contentBytes: collected.contentBytes,
      inventoryDigest: collected.inventoryDigest,
    });
    const existing = db
      .prepare("SELECT inventory_json FROM phase4_history_inventories WHERE run_id = ?")
      .get(input.runId);
    if (existing !== undefined) {
      if (readText(existing, "inventory_json") !== JSON.stringify(inventory)) throw stale();
    } else {
      // Exactly one current run per gap; restarting with a new explicit run id
      // replaces its incomplete coverage obligation, not the original facts.
      db.prepare(
        "DELETE FROM phase4_history_inventories WHERE scope_key = ? AND provider_id = ?",
      ).run(input.scopeKey, input.providerId);
      db.prepare("INSERT INTO phase4_history_inventories VALUES (?, ?, ?, ?)").run(
        input.runId,
        input.scopeKey,
        input.providerId,
        JSON.stringify(inventory),
      );
      const insert = db.prepare(
        "INSERT INTO phase4_history_inventory_items VALUES (?, ?, ?, ?, ?)",
      );
      for (const item of collected.items)
        insert.run(input.runId, item.ordinal, item.kind, item.id, item.digest);
    }
    db.exec("COMMIT");
    return inventory;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function currentInventory(db: SqliteDatabase, runId: string) {
  const inventory = readRun(db, runId);
  assertGap(db, inventory);
  const current = collect(db, inventory);
  if (
    current.itemCount !== inventory.itemCount ||
    current.inventoryDigest !== inventory.inventoryDigest ||
    current.contentBytes !== inventory.contentBytes
  )
    throw stale();
  const stored = db
    .prepare(
      "SELECT ordinal, kind, item_id, item_digest FROM phase4_history_inventory_items WHERE run_id = ? ORDER BY ordinal",
    )
    .all(runId);
  if (
    stored.length !== current.items.length ||
    stored.some((row, index) => {
      const item = current.items[index]!;
      return (
        row.ordinal !== item.ordinal ||
        row.kind !== item.kind ||
        row.item_id !== item.id ||
        row.item_digest !== item.digest
      );
    })
  )
    throw new PersistenceError("record_invalid", "history inventory integrity check failed");
  return { inventory, items: current.items };
}

export function withCurrentInventory<T>(
  db: SqliteDatabase,
  runId: string,
  read: (inventory: HistoryInventory, items: ReturnType<typeof collect>["items"]) => T,
  transaction: "read" | "write" = "read",
): T {
  db.exec(transaction === "write" ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const { inventory, items } = currentInventory(db, runId);
    const result = read(inventory, items);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function readHistoryInventoryPage(
  db: SqliteDatabase,
  input: HistoryInventoryPageInput,
): HistoryInventoryPage {
  return withCurrentInventory(db, input.runId, (inventory, items) => {
    if (input.after > inventory.itemCount)
      throw new PersistenceError("invalid_request", "history inventory cursor exceeds item count");
    const selected = items
      .slice(input.after, input.after + input.limit)
      .map(({ body: _body, ...item }) => item);
    return HistoryInventoryPageSchema.parse({
      inventory,
      items: selected,
      done: input.after + selected.length === items.length,
    });
  });
}

export function readHistoryInventoryItem(
  db: SqliteDatabase,
  input: HistoryInventoryItemInput,
): HistoryInventoryItem {
  return withCurrentInventory(db, input.runId, (_inventory, items) => {
    const item = items[input.ordinal - 1];
    if (item === undefined)
      throw new PersistenceError("invalid_request", "history inventory item not found");
    if (Buffer.byteLength(item.body) > 1_048_576)
      throw new PersistenceError("invalid_request", "history inventory item exceeds RPC limit");
    return HistoryInventoryItemSchema.parse({ ...item, body: JSON.parse(item.body) });
  });
}

export const HistoryRecoveryInputSchema = z.strictObject({
  scopeKey: MemoryPolicyStampSchema.shape.scopeKey,
  providerId: z.string().min(1).max(128),
});
export type HistoryRecoveryInput = z.infer<typeof HistoryRecoveryInputSchema>;
export const HistoryRecoveryStateSchema = HistoryRecoveryInputSchema.extend({
  policy: MemoryPolicySnapshotSchema,
  transmissionBlocked: z.boolean(),
  gap: MemoryHistoryGapSchema.nullable(),
  inventory: HistoryInventorySchema.nullable(),
  inventoryStatus: z.enum(["absent", "current", "stale"]),
});
export type HistoryRecoveryState = z.infer<typeof HistoryRecoveryStateSchema>;

/** Discover a durable recovery identity in one read snapshot; never release or
 * replace a run, and never classify damaged stored data as an ordinary restart. */
export function readHistoryRecoveryState(
  db: SqliteDatabase,
  input: HistoryRecoveryInput,
): HistoryRecoveryState {
  db.exec("BEGIN");
  try {
    const policy = readMemoryPolicy(db, input.scopeKey);
    const transmissionBlocked =
      db.prepare("SELECT blocked FROM phase4_memory_policy WHERE scope_key=?").get(input.scopeKey)!
        .blocked !== 0;
    const row = db
      .prepare(
        "SELECT gap_id, gap_json, gap_digest FROM phase4_history_gaps WHERE scope_key=? AND provider_id=?",
      )
      .get(input.scopeKey, input.providerId);
    const gap =
      row === undefined
        ? null
        : MemoryHistoryGapSchema.parse(JSON.parse(readText(row, "gap_json")));
    if (
      row !== undefined &&
      (hash(readText(row, "gap_json")) !== row.gap_digest ||
        gap?.gapId !== row.gap_id ||
        gap?.providerId !== input.providerId)
    )
      throw new PersistenceError("record_invalid", "history gap identity check failed");
    const saved = db
      .prepare("SELECT run_id FROM phase4_history_inventories WHERE scope_key=? AND provider_id=?")
      .get(input.scopeKey, input.providerId);
    let inventory: HistoryInventory | null = null;
    let inventoryStatus: "absent" | "current" | "stale" = "absent";
    if (saved !== undefined) {
      if (gap === null)
        throw new PersistenceError("record_invalid", "inventory has no history gap");
      inventory = readRun(db, readText(saved, "run_id"));
      try {
        currentInventory(db, inventory.runId);
        inventoryStatus = "current";
      } catch (error) {
        if (!(error instanceof PersistenceError) || error.code !== "idempotency_conflict")
          throw error;
        inventoryStatus = "stale";
      }
    }
    const result = HistoryRecoveryStateSchema.parse({
      ...input,
      policy,
      transmissionBlocked,
      gap,
      inventory,
      inventoryStatus,
    });
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
