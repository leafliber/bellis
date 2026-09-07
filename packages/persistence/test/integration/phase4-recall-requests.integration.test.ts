import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createPersistenceClient, type RecallRequestWrite } from "../../src/index.js";
import {
  SESSION_ID,
  TRACE,
  WORKER_FIXTURE,
  createTempDataDirectory,
  cleanupTempDataDirectory,
} from "../helpers.js";

const scopeKey = "c".repeat(64);
const record = (): RecallRequestWrite => ({
  policy: { scopeKey, generation: 0 },
  providerId: "iris",
  sessionId: SESSION_ID,
  request: {
    schemaVersion: 1,
    attemptId: randomUUID(),
    requestId: "original-request",
    agentId: "agent",
    spaceId: "space",
    body: {
      schema_version: 1,
      request_id: "original-request",
      topic: "original private topic",
      deadline_at: "2026-09-07T00:00:00Z",
    },
  },
});
const gap = {
  schemaVersion: 1 as const,
  providerId: "iris",
  agentId: "agent",
  gapId: "b".repeat(64),
  cursor: "8",
  reason: "history_unavailable" as const,
};

it("retains prepared attempts across replay/restart and exposes their exact bodies in the history inventory", async () => {
  const dataDirectory = createTempDataDirectory("recall-requests-");
  let client = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
  try {
    await client.migrate();
    await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 0, trace: TRACE });
    await client.phase4EnsureMemoryPolicy(scopeKey, "1", SESSION_ID);
    const first = record();
    await client.phase4RecordRecallRequest(first);
    await client.phase4RecordRecallRequest(first);
    await expect(
      client.phase4RecordRecallRequest({
        ...first,
        request: { ...first.request, body: { altered: true } },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await client.close();
    client = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
    await client.migrate();
    await client.phase4RecordRecallRequest(first);
    const retry = record();
    retry.request.body.deadline_at = "2026-09-07T00:01:00Z";
    await client.phase4RecordRecallRequest(retry);
    await client.phase4BeginHistoryGap(scopeKey, gap);
    const inventory = await client.phase4BeginHistoryInventory({
      runId: randomUUID(),
      scopeKey,
      providerId: "iris",
      gapId: gap.gapId,
      generation: 0,
    });
    expect(inventory.itemCount).toBe(2);
    const page = await client.phase4ReadHistoryInventoryPage({
      runId: inventory.runId,
      after: 0,
      limit: 64,
    });
    expect(page.items.map((item) => item.kind)).toEqual(["recall_request", "recall_request"]);
    for (const item of page.items) {
      expect(
        (
          await client.phase4ReadHistoryInventoryItem({
            runId: inventory.runId,
            ordinal: item.ordinal,
          })
        ).body,
      ).toEqual(item.id === first.request.attemptId ? first : retry);
    }
    await expect(client.phase4RecordRecallRequest(record())).rejects.toBeDefined();
    expect((await client.phase4ReadMemoryPolicy(scopeKey)).historyBlocked).toBe(true);
  } finally {
    await client.close();
    cleanupTempDataDirectory(dataDirectory);
  }
});

it("requires Session ownership and current policy and rolls back failed inserts before original-attempt retry", async () => {
  const dataDirectory = createTempDataDirectory("recall-request-policy-");
  const client = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
  try {
    await client.migrate();
    await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 0, trace: TRACE });
    await client.phase4EnsureMemoryPolicy(scopeKey, "1");
    const input = record();
    await expect(client.phase4RecordRecallRequest(input)).rejects.toBeDefined();
    await client.phase4EnsureMemoryPolicy(scopeKey, "1", SESSION_ID);
    await expect(
      client.phase4RecordRecallRequest({ ...input, policy: { scopeKey, generation: 1 } }),
    ).rejects.toBeDefined();
    const other = "d".repeat(64);
    await client.phase4EnsureMemoryPolicy(other, "1");
    await expect(
      client.phase4RecordRecallRequest({ ...input, policy: { scopeKey: other, generation: 0 } }),
    ).rejects.toBeDefined();
    const db = new DatabaseSync(join(dataDirectory, "state.db"));
    try {
      db.exec(
        "CREATE TRIGGER fail_request BEFORE INSERT ON phase4_recall_requests BEGIN SELECT RAISE(ABORT, 'injected request failure'); END",
      );
      await expect(client.phase4RecordRecallRequest(input)).rejects.toBeDefined();
      expect(db.prepare("SELECT COUNT(*) AS n FROM phase4_recall_requests").get()?.n).toBe(0);
      db.exec("DROP TRIGGER fail_request");
      await client.phase4RecordRecallRequest(input);
      expect(
        db.prepare("SELECT request_json FROM phase4_recall_requests").get()?.request_json,
      ).toBe(JSON.stringify(input));
    } finally {
      db.close();
    }
    await expect(
      client.phase4RecordRecallRequest({
        ...record(),
        request: { ...record().request, body: { topic: "x".repeat(65536) } },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  } finally {
    await client.close();
    cleanupTempDataDirectory(dataDirectory);
  }
});
