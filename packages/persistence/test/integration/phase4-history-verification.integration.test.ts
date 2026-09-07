import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createPersistenceClient, type HistoryVerificationBatch } from "../../src/index.js";
import {
  SESSION_ID,
  TRACE,
  WORKER_FIXTURE,
  createTempDataDirectory,
  cleanupTempDataDirectory,
} from "../helpers.js";

const scopeKey = "c".repeat(64);
const gap = {
  schemaVersion: 1 as const,
  providerId: "iris",
  agentId: "agent",
  gapId: "a".repeat(64),
  cursor: "8",
  reason: "history_unavailable" as const,
};
const begin = () => ({
  runId: randomUUID(),
  scopeKey,
  providerId: "iris",
  gapId: gap.gapId,
  generation: 0,
});
const checkedAt = "2026-09-07T00:00:00.123456Z";

async function fixture() {
  const dataDirectory = createTempDataDirectory("history-verification-");
  const create = () => createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
  const client = create();
  await client.migrate();
  await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 0, trace: TRACE });
  await client.phase4EnsureMemoryPolicy(scopeKey, "1", SESSION_ID);
  const requests = ["first", "second"].map((requestId) => ({
    policy: { scopeKey, generation: 0 },
    providerId: "iris",
    sessionId: SESSION_ID,
    request: {
      schemaVersion: 1 as const,
      attemptId: randomUUID(),
      requestId,
      agentId: "agent",
      spaceId: "space",
      body: { request_id: requestId, topic: "original topic" },
    },
  }));
  for (const request of requests) await client.phase4RecordRecallRequest(request);
  await client.phase4WriteProviderState({
    scopeKey,
    providerId: "iris",
    expectedRevision: 0,
    state: { original: true },
  });
  await client.phase4BeginHistoryGap(scopeKey, gap);
  const inventory = await client.phase4BeginHistoryInventory(begin());
  const page = await client.phase4ReadHistoryInventoryPage({
    runId: inventory.runId,
    after: 0,
    limit: 64,
  });
  const batch: HistoryVerificationBatch = {
    batchId: randomUUID(),
    runId: inventory.runId,
    inventoryDigest: inventory.inventoryDigest,
    scheme: "recall-current-v1",
    checkedAt,
    results: page.items
      .filter((item) => item.kind === "recall_request")
      .map((item, index) => ({
        ordinal: item.ordinal,
        digest: item.digest,
        requestId: requests.find((r) => r.request.attemptId === item.id)!.request.requestId,
        status: index === 0 ? "valid" : "unavailable",
      })),
  };
  const f = {
    client,
    inventory,
    batch,
    page,
    audit: new DatabaseSync(`${dataDirectory}/state.db`),
    async restart() {
      await f.client.close();
      f.client = create();
      await f.client.migrate();
    },
    read: () =>
      f.client.phase4ReadHistoryVerificationPage({ runId: inventory.runId, after: 0, limit: 64 }),
    async close() {
      f.audit.close();
      await f.client.close();
      cleanupTempDataDirectory(dataDirectory);
    },
  };
  return f;
}

it("persists an atomic batch with distinct unavailable/unchecked facts, replays after restart and resets coverage only with a new inventory", async () => {
  const f = await fixture();
  try {
    expect((await f.read()).items.every((item) => item.verification === null)).toBe(true);
    await f.client.phase4RecordHistoryVerification(f.batch);
    await f.client.phase4RecordHistoryVerification(f.batch);
    const saved = await f.read();
    expect(saved.done).toBe(true);
    expect(saved.items.map((item) => item.verification?.status ?? null)).toEqual([
      null,
      "valid",
      "unavailable",
    ]);
    expect(saved.items[1]!.verification).toEqual({
      batchId: f.batch.batchId,
      scheme: f.batch.scheme,
      checkedAt,
      requestId: f.batch.results[0]!.requestId,
      status: "valid",
    });
    await f.restart();
    expect(await f.read()).toEqual(saved);
    await f.client.phase4RecordHistoryVerification(f.batch);
    expect(
      f.audit.prepare("SELECT count(*) AS n FROM phase4_history_verification_batches").get()?.n,
    ).toBe(1);
    await expect(
      f.client.phase4RecordHistoryVerification({ ...f.batch, checkedAt: "2026-09-07T00:01:00Z" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      f.client.phase4RecordHistoryVerification({ ...f.batch, batchId: randomUUID() }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect((await f.client.phase4ReadMemoryPolicy(scopeKey)).historyBlocked).toBe(true);
    const next = await f.client.phase4BeginHistoryInventory(begin());
    expect(
      f.audit.prepare("SELECT count(*) AS n FROM phase4_history_verification_batches").get()?.n,
    ).toBe(0);
    expect(
      f.audit.prepare("SELECT count(*) AS n FROM phase4_history_verification_items").get()?.n,
    ).toBe(0);
    await expect(f.read()).rejects.toMatchObject({ code: "invalid_request" });
    await expect(f.client.phase4RecordHistoryVerification(f.batch)).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(
      (
        await f.client.phase4ReadHistoryVerificationPage({ runId: next.runId, after: 0, limit: 64 })
      ).items.every((item) => item.verification === null),
    ).toBe(true);
    expect((await f.client.phase4ReadMemoryPolicy(scopeKey)).historyBlocked).toBe(true);
  } finally {
    await f.close();
  }
});

it("rolls back both batch and item bindings on a partial insert failure, then rejects damaged durable evidence", async () => {
  const f = await fixture();
  try {
    f.audit.exec(
      `CREATE TRIGGER fail_verification BEFORE INSERT ON phase4_history_verification_items WHEN NEW.ordinal=${f.batch.results[1]!.ordinal} BEGIN SELECT RAISE(ABORT, 'injected'); END`,
    );
    await expect(f.client.phase4RecordHistoryVerification(f.batch)).rejects.toBeDefined();
    expect(
      f.audit.prepare("SELECT count(*) AS n FROM phase4_history_verification_batches").get()?.n,
    ).toBe(0);
    expect(
      f.audit.prepare("SELECT count(*) AS n FROM phase4_history_verification_items").get()?.n,
    ).toBe(0);
    expect((await f.read()).items.every((item) => item.verification === null)).toBe(true);
    f.audit.exec("DROP TRIGGER fail_verification");
    await f.client.phase4RecordHistoryVerification(f.batch);
    const original = f.audit
      .prepare("SELECT batch_digest FROM phase4_history_verification_batches")
      .get()!.batch_digest;
    f.audit
      .prepare("UPDATE phase4_history_verification_batches SET batch_digest=?")
      .run("0".repeat(64));
    await expect(f.read()).rejects.toMatchObject({ code: "record_invalid" });
    await expect(f.client.phase4RecordHistoryVerification(f.batch)).rejects.toMatchObject({
      code: "record_invalid",
    });
    f.audit.prepare("UPDATE phase4_history_verification_batches SET batch_digest=?").run(original!);
    f.audit
      .prepare("DELETE FROM phase4_history_verification_items WHERE ordinal=?")
      .run(f.batch.results[1]!.ordinal);
    // Reading only the other member still validates the entire stored batch.
    await expect(
      f.client.phase4ReadHistoryVerificationPage({
        runId: f.batch.runId,
        after: f.batch.results[0]!.ordinal - 1,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "record_invalid" });
    await expect(f.client.phase4RecordHistoryVerification(f.batch)).rejects.toMatchObject({
      code: "record_invalid",
    });
    f.audit.exec("DELETE FROM phase4_history_verification_items");
    await expect(f.read()).rejects.toMatchObject({ code: "record_invalid" });
    await expect(
      f.client.phase4ReadHistoryVerificationPage({
        runId: f.batch.runId,
        after: f.inventory.itemCount,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "record_invalid" });
    await expect(
      f.client.phase4RecordHistoryVerification({ ...f.batch, batchId: randomUUID() }),
    ).rejects.toMatchObject({ code: "record_invalid" });
    expect((await f.client.phase4ReadMemoryPolicy(scopeKey)).historyBlocked).toBe(true);
  } finally {
    await f.close();
  }
});

it("rejects old verification reads and late response writes after the source or policy changes", async () => {
  const f = await fixture();
  try {
    await f.client.phase4RecordHistoryVerification(f.batch);
    await f.client.phase4WriteProviderState({
      scopeKey,
      providerId: "iris",
      expectedRevision: 1,
      state: { changed: true },
    });
    await expect(f.read()).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(f.client.phase4RecordHistoryVerification(f.batch)).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    const next = await f.client.phase4BeginHistoryInventory(begin());
    const batch = {
      ...f.batch,
      batchId: randomUUID(),
      runId: next.runId,
      inventoryDigest: next.inventoryDigest,
    };
    await f.client.phase4RecordHistoryVerification(batch);
    await f.client.phase4ChangeMemoryPolicy({
      scopeKey,
      expectedGeneration: 0,
      changeId: randomUUID(),
      privacyRevision: "2",
      blocked: false,
      reason: "privacy",
      tombstones: [],
    });
    await expect(
      f.client.phase4ReadHistoryVerificationPage({ runId: next.runId, after: 0, limit: 1 }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(f.client.phase4RecordHistoryVerification(batch)).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    expect((await f.client.phase4ReadMemoryPolicy(scopeKey)).historyBlocked).toBe(true);
  } finally {
    await f.close();
  }
});

it("requires exact original-request bindings, unique response identities and bounded complete batches", async () => {
  const f = await fixture();
  try {
    const result = f.batch.results[0]!;
    for (const invalid of [
      { ...f.batch, inventoryDigest: "0".repeat(64) },
      { ...f.batch, results: [{ ...result, requestId: "different-request" }] },
      { ...f.batch, results: [{ ...result, digest: "0".repeat(64) }] },
      { ...f.batch, results: [{ ...result, ordinal: 1, digest: f.page.items[0]!.digest }] },
      { ...f.batch, results: [{ ...result, ordinal: 4096 }] },
    ])
      await expect(f.client.phase4RecordHistoryVerification(invalid)).rejects.toMatchObject({
        code: "idempotency_conflict",
      });
    for (const invalid of [
      { ...f.batch, results: [] },
      { ...f.batch, results: [result, result] },
      { ...f.batch, results: [result, { ...f.batch.results[1]!, requestId: result.requestId }] },
      { ...f.batch, results: Array.from({ length: 17 }, () => result) },
      { ...f.batch, checkedAt: "not-a-date" },
    ])
      await expect(f.client.phase4RecordHistoryVerification(invalid)).rejects.toMatchObject({
        code: "invalid_request",
      });
    await expect(
      f.client.phase4ReadHistoryVerificationPage({ runId: f.batch.runId, after: 4, limit: 1 }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(
      f.audit.prepare("SELECT count(*) AS n FROM phase4_history_verification_batches").get()?.n,
    ).toBe(0);
    // Distinct batches retain distinct evaluation times, not a synthetic global snapshot.
    for (const [index, verdict] of f.batch.results.entries())
      await f.client.phase4RecordHistoryVerification({
        ...f.batch,
        batchId: randomUUID(),
        checkedAt: `2026-09-07T00:0${index}:00Z`,
        results: [verdict],
      });
    const page = await f.read();
    expect(page.items[1]!.verification!.checkedAt).not.toBe(page.items[2]!.verification!.checkedAt);
    expect((await f.client.phase4ReadMemoryPolicy(scopeKey)).historyBlocked).toBe(true);
  } finally {
    await f.close();
  }
});
