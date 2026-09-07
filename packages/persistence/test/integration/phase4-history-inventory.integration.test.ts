import { ContextManifestSchema } from "@bellis/contracts";
import { context } from "../phase4-fixtures.js";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createPersistenceClient } from "../../src/index.js";
import {
  SESSION_ID,
  TRACE,
  WORKER_FIXTURE,
  createTempDataDirectory,
  cleanupTempDataDirectory,
} from "../helpers.js";
import { fixture, target, adopt, commit, confirm } from "../phase4-effect-fixtures.js";

const scopeKey = "c".repeat(64);
const gap = {
  schemaVersion: 1 as const,
  providerId: "iris",
  agentId: "agent",
  gapId: "a".repeat(64),
  reason: "history_unavailable" as const,
  cursor: "9",
  eventId: "old:9",
};
const request = () => ({
  runId: randomUUID(),
  scopeKey,
  providerId: "iris",
  gapId: gap.gapId,
  generation: 0,
});
const claim = { limit: 10, leaseMs: 30000, ownerInstanceId: "inventory" };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

it("freezes a complete paginated scope inventory, returns matching original facts and survives Worker restart", async () => {
  const dataDirectory = createTempDataDirectory("history-inventory-");
  let client = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
  try {
    await client.migrate();
    await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 0, trace: TRACE });
    await client.phase4EnsureMemoryPolicy(scopeKey, "1");
    const policy = { scopeKey, generation: 0 },
      f = fixture("subtitle");
    f.preparation.targets = [{ ...target, policy }];
    const adopted = context(f.plan.scene.cycleId);
    adopted.manifest = ContextManifestSchema.parse({ ...adopted.manifest, policy });
    adopted.manifestDigest = hash(JSON.stringify(adopted.manifest));
    await client.phase3AdoptCycle({
      sessionId: SESSION_ID,
      cycleId: f.plan.scene.cycleId,
      turnId: randomUUID(),
      batchId: randomUUID(),
      cycleIndex: 0,
      watermarkFrom: 1n,
      watermarkTo: 1n,
      next: "finish",
      degraded: false,
      packetDigest: "d".repeat(64),
      toolRuns: [],
      context: adopted,
      trace: TRACE,
    });
    await client.phase4PrepareEffects(f.preparation);
    await commit(client, f);
    await confirm(client, f.receipt());
    await client.phase4BeginHistoryGap(scopeKey, gap);
    await client.phase4WriteProviderState({
      scopeKey,
      providerId: "iris",
      expectedRevision: 0,
      state: {
        version: 1,
        sourceCursors: {},
        personaCache: {},
        pending: [],
        historyGap: gap,
        eventCursor: "9",
        eventId: "old:9",
      },
    });
    const otherScope = "f".repeat(64),
      otherSession = randomUUID();
    await client.ensureSession({ sessionId: otherSession, createdAtMs: 0, trace: TRACE });
    await client.phase4EnsureMemoryPolicy(otherScope, "1", otherSession);
    const other = context(randomUUID());
    other.manifest = ContextManifestSchema.parse({
      ...other.manifest,
      sessionId: otherSession,
      policy: { scopeKey: otherScope, generation: 0 },
    });
    other.manifestDigest = hash(JSON.stringify(other.manifest));
    await client.phase3AdoptCycle({
      sessionId: otherSession,
      cycleId: other.manifest.cycleId,
      turnId: randomUUID(),
      batchId: randomUUID(),
      cycleIndex: 0,
      watermarkFrom: 1n,
      watermarkTo: 1n,
      next: "finish",
      degraded: false,
      packetDigest: "d".repeat(64),
      toolRuns: [],
      context: other,
      trace: TRACE,
    });
    await client.phase4WriteProviderState({
      scopeKey: otherScope,
      providerId: "iris",
      expectedRevision: 0,
      state: { excluded: true },
    });
    const discovery = { scopeKey, providerId: "iris" };
    expect(await client.phase4ReadHistoryRecoveryState(discovery)).toMatchObject({
      inventory: null,
      inventoryStatus: "absent",
      gap,
      transmissionBlocked: false,
    });
    const input = request(),
      inventory = await client.phase4BeginHistoryInventory(input);
    expect(await client.phase4ReadHistoryRecoveryState(discovery)).toMatchObject({
      inventory,
      inventoryStatus: "current",
      gap,
    });
    expect(inventory.itemCount).toBe(5); // manifest, effect, observation, Usage, Provider state
    expect(await client.phase4BeginHistoryInventory(input)).toEqual(inventory);
    const kinds: string[] = [],
      ids: string[] = [];
    for (let after = 0; after < inventory.itemCount; after++) {
      const page = await client.phase4ReadHistoryInventoryPage({
        runId: input.runId,
        after,
        limit: 1,
      });
      expect(page.inventory).toEqual(inventory);
      expect(page.items).toHaveLength(1);
      expect(page.done).toBe(after === 4);
      const descriptor = page.items[0]!;
      const item = await client.phase4ReadHistoryInventoryItem({
        runId: input.runId,
        ordinal: descriptor.ordinal,
      });
      expect(item).toMatchObject(descriptor);
      expect(hash(JSON.stringify(item.body))).toBe(item.digest);
      kinds.push(item.kind);
      ids.push(item.id);
    }
    expect(kinds).toEqual(["effect", "manifest", "observation", "provider_state", "usage"]);
    expect(new Set(ids).size).toBe(5);
    await expect(
      client.phase4ReadHistoryInventoryPage({ runId: input.runId, after: 6, limit: 1 }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      client.phase4ReadHistoryInventoryItem({ runId: input.runId, ordinal: 6 }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await client.close();
    client = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
    await client.migrate();
    expect(
      (await client.phase4ReadHistoryInventoryPage({ runId: input.runId, after: 5, limit: 64 }))
        .done,
    ).toBe(true);
    expect(await client.phase4ReadHistoryRecoveryState(discovery)).toMatchObject({
      inventory,
      inventoryStatus: "current",
    });
    expect(await client.phase4ReadMemoryPolicy(scopeKey)).toMatchObject({
      blocked: true,
      historyBlocked: true,
      generation: 0,
    });
    const unrelated = await client.claimOutbox(claim);
    expect(unrelated).toHaveLength(1);
    expect(unrelated[0]!.payload).toMatchObject({ policy: { scopeKey: otherScope } });
  } finally {
    await client.close();
    cleanupTempDataDirectory(dataDirectory);
  }
});

it("invalidates the inventory on a late actual effect, original remote ACK, or policy change", async () => {
  const dataDirectory = createTempDataDirectory("history-inventory-stale-");
  const client = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
  try {
    await client.migrate();
    await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 0, trace: TRACE });
    await client.phase4EnsureMemoryPolicy(scopeKey, "1");
    const policy = { scopeKey, generation: 0 },
      f = fixture("subtitle");
    f.preparation.targets = [{ ...target, policy }];
    await adopt(client, f, 0, policy);
    await client.phase4PrepareEffects(f.preparation);
    await commit(client, f);
    await confirm(client, f.receipt());
    const [leased] = await client.claimOutbox(claim);
    await client.phase4BeginHistoryGap(scopeKey, gap);
    const first = request();
    await client.phase4BeginHistoryInventory(first);
    await confirm(client, f.receipt(1));
    expect(
      await client.phase4ReadHistoryRecoveryState({ scopeKey, providerId: "iris" }),
    ).toMatchObject({ inventory: { runId: first.runId }, inventoryStatus: "stale" });
    await expect(
      client.phase4ReadHistoryInventoryPage({ runId: first.runId, after: 0, limit: 64 }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(client.phase4BeginHistoryInventory(first)).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    const second = request();
    expect((await client.phase4BeginHistoryInventory(second)).itemCount).toBe(5);
    await client.completeOutbox({
      outboxId: leased!.outboxId,
      ownerInstanceId: claim.ownerInstanceId,
    });
    await expect(
      client.phase4ReadHistoryInventoryPage({ runId: second.runId, after: 0, limit: 64 }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    const third = request();
    await client.phase4BeginHistoryInventory(third);
    await client.phase4ChangeMemoryPolicy({
      scopeKey,
      expectedGeneration: 0,
      changeId: randomUUID(),
      privacyRevision: "2",
      blocked: false,
      reason: "privacy",
      tombstones: [],
    });
    await expect(
      client.phase4ReadHistoryInventoryItem({ runId: third.runId, ordinal: 1 }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await client.phase4ReadMemoryPolicy(scopeKey)).toMatchObject({ historyBlocked: true });
  } finally {
    await client.close();
    cleanupTempDataDirectory(dataDirectory);
  }
});

it("requires the exact gap, rolls back partial inventory replacement and rejects tampered inventory/source digests", async () => {
  const dataDirectory = createTempDataDirectory("history-inventory-integrity-");
  const client = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
  let audit: DatabaseSync | undefined;
  try {
    await client.migrate();
    await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 0, trace: TRACE });
    await client.phase4EnsureMemoryPolicy(scopeKey, "1");
    await expect(client.phase4BeginHistoryInventory(request())).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    const f = fixture("subtitle");
    await adopt(client, f, 0, { scopeKey, generation: 0 });
    await client.phase4BeginHistoryGap(scopeKey, gap);
    await expect(
      client.phase4BeginHistoryInventory({ ...request(), gapId: "b".repeat(64) }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    const input = request();
    await client.phase4BeginHistoryInventory(input);
    audit = new DatabaseSync(`${dataDirectory}/state.db`);
    audit.exec(
      "CREATE TRIGGER fail_inventory BEFORE INSERT ON phase4_history_inventory_items BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    await expect(client.phase4BeginHistoryInventory(request())).rejects.toBeDefined();
    expect(
      (await client.phase4ReadHistoryInventoryPage({ runId: input.runId, after: 0, limit: 1 }))
        .items,
    ).toHaveLength(1);
    audit.exec("DROP TRIGGER fail_inventory");
    audit.prepare("UPDATE phase4_history_inventory_items SET item_digest = ?").run("0".repeat(64));
    await expect(
      client.phase4ReadHistoryInventoryPage({ runId: input.runId, after: 0, limit: 1 }),
    ).rejects.toMatchObject({ code: "record_invalid" });
    await expect(
      client.phase4ReadHistoryRecoveryState({ scopeKey, providerId: "iris" }),
    ).rejects.toMatchObject({ code: "record_invalid" });
    audit.prepare("UPDATE phase4_context_manifests SET manifest_digest = ?").run("0".repeat(64));
    await expect(client.phase4BeginHistoryInventory(request())).rejects.toMatchObject({
      code: "record_invalid",
    });
  } finally {
    audit?.close();
    await client.close();
    cleanupTempDataDirectory(dataDirectory);
  }
});

it("does not treat an empty inventory as gap release and refuses oversized inventories without truncation", async () => {
  const dataDirectory = createTempDataDirectory("history-inventory-capacity-");
  const client = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
  let audit: DatabaseSync | undefined;
  try {
    await client.migrate();
    await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 0, trace: TRACE });
    await client.phase4EnsureMemoryPolicy(scopeKey, "1", SESSION_ID);
    expect(
      await client.phase4ReadHistoryRecoveryState({ scopeKey, providerId: "iris" }),
    ).toMatchObject({ gap: null, inventory: null, inventoryStatus: "absent" });
    await client.phase4BeginHistoryGap(scopeKey, gap);
    const input = request(),
      inventory = await client.phase4BeginHistoryInventory(input);
    expect(inventory.itemCount).toBe(0);
    expect(
      await client.phase4ReadHistoryInventoryPage({ runId: input.runId, after: 0, limit: 64 }),
    ).toMatchObject({ items: [], done: true });
    expect(await client.phase4ReadMemoryPolicy(scopeKey)).toMatchObject({ historyBlocked: true });
    await expect(
      client.phase4ReadHistoryInventoryPage({ runId: input.runId, after: 0, limit: 65 }),
    ).rejects.toBeDefined();
    audit = new DatabaseSync(`${dataDirectory}/state.db`);
    // A legacy-sized fixture exercises capacity admission before any snapshot
    // materialization. These are not claims of newly accepted business facts.
    const insert = audit.prepare(
      "INSERT INTO outbox(outbox_id, session_id, topic, partition_key, schema_version, payload_json, status, attempts, available_at_ms, created_at_ms, updated_at_ms) VALUES (?, ?, 'memory.usage.v1', 'iris', 1, ?, 'pending', 0, 0, 0, 0)",
    );
    audit.exec("BEGIN IMMEDIATE");
    for (let n = 0; n < 4097; n++)
      insert.run(
        randomUUID(),
        SESSION_ID,
        JSON.stringify({ providerId: "iris", report: { originalId: n } }),
      );
    audit.exec("COMMIT");
    await expect(client.phase4BeginHistoryInventory(request())).rejects.toMatchObject({
      code: "database_busy",
    });
    expect(audit.prepare("SELECT count(*) AS n FROM phase4_history_inventories").get()?.n).toBe(1);
    expect(audit.prepare("SELECT run_id FROM phase4_history_inventories").get()?.run_id).toBe(
      input.runId,
    );
    expect(await client.phase4ReadMemoryPolicy(scopeKey)).toMatchObject({ historyBlocked: true });
  } finally {
    audit?.close();
    await client.close();
    cleanupTempDataDirectory(dataDirectory);
  }
});
