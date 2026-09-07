import { randomUUID } from "node:crypto";
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

const scopeKey = "e".repeat(64);
const gap = {
  schemaVersion: 1 as const,
  providerId: "iris",
  agentId: "agent",
  gapId: "a".repeat(64),
  reason: "history_unavailable" as const,
  cursor: "7",
  eventId: "old:7",
};
const claim = { limit: 100, leaseMs: 30_000, ownerInstanceId: "gap-test" };

it("holds original observations across a history gap and restart while recording late actual effects", async () => {
  const dataDirectory = createTempDataDirectory("history-gap-");
  let client = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
  let audit: DatabaseSync | undefined;
  try {
    await client.migrate();
    await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 0, trace: TRACE });
    await client.phase4EnsureMemoryPolicy(scopeKey, "1");
    const policy = { scopeKey, generation: 0 };
    const f = fixture("subtitle");
    f.preparation.targets = [{ ...target, policy }];
    await adopt(client, f, 0, policy);
    await client.phase4PrepareEffects(f.preparation);
    await commit(client, f);
    expect((await confirm(client, f.receipt())).outcome).toBe("recorded");
    const [leased] = await client.claimOutbox(claim);
    expect(leased).toBeDefined();
    audit = new DatabaseSync(`${dataDirectory}/state.db`);
    const original = audit
      .prepare("SELECT outbox_id, payload_json, attempts, available_at_ms FROM outbox")
      .get();
    const blocked = await client.phase4BeginHistoryGap(scopeKey, gap);
    expect(blocked).toMatchObject({
      generation: 0,
      blocked: true,
      historyBlocked: true,
      tombstones: [],
    });
    expect(await client.phase4BeginHistoryGap(scopeKey, gap)).toEqual(blocked);
    await expect(
      client.phase4BeginHistoryGap(scopeKey, { ...gap, eventId: "changed" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(
      await client.retryOutbox({
        outboxId: leased!.outboxId,
        ownerInstanceId: claim.ownerInstanceId,
        errorCode: "privacy_revoked",
        retryable: false,
      }),
    ).toEqual({ disposition: "retry" });
    expect(
      audit.prepare("SELECT outbox_id, payload_json, attempts, available_at_ms FROM outbox").get(),
    ).toEqual(original);
    expect((await confirm(client, f.receipt(1))).outcome).toBe("recorded");
    expect(await client.readOutboxStats()).toMatchObject({ pending: 2, dead: 0 });
    expect(await client.claimOutbox(claim)).toEqual([]);
    await expect(client.phase4ReadConfirmedSpeech(SESSION_ID, 20, policy)).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(await client.phase4ReadConfirmedSpeech(SESSION_ID)).toHaveLength(2);
    await expect(adopt(client, fixture("subtitle"), 1, policy)).rejects.toMatchObject({
      code: "invalid_request",
    });
    audit.close();
    audit = undefined;
    await client.close();
    client = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
    await client.migrate();
    expect(await client.phase4ReadMemoryPolicy(scopeKey)).toEqual(blocked);
    expect(await client.phase4ReadConfirmedSpeech(SESSION_ID)).toHaveLength(2);
    expect(await client.readOutboxStats()).toMatchObject({ pending: 2, dead: 0 });
    expect(await client.claimOutbox(claim)).toEqual([]);
    // A normal policy update cannot erase an unresolved history barrier.
    expect(
      await client.phase4ChangeMemoryPolicy({
        scopeKey,
        expectedGeneration: 0,
        changeId: randomUUID(),
        privacyRevision: "1",
        blocked: false,
        reason: "privacy",
        tombstones: [],
      }),
    ).toMatchObject({ generation: 1, blocked: true, historyBlocked: true });
  } finally {
    audit?.close();
    await client.close();
    cleanupTempDataDirectory(dataDirectory);
  }
});

it("preserves a real remote ACK during a gap and still enforces a subsequent privacy revocation", async () => {
  const dataDirectory = createTempDataDirectory("history-gap-ack-");
  const client = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
  try {
    await client.migrate();
    await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 0, trace: TRACE });
    await client.phase4EnsureMemoryPolicy(scopeKey, "1");
    const policy = { scopeKey, generation: 0 };
    const f = fixture("subtitle");
    f.preparation.targets = [{ ...target, policy }];
    await adopt(client, f, 0, policy);
    await client.phase4PrepareEffects(f.preparation);
    await commit(client, f);
    await confirm(client, f.receipt());
    const [leased] = await client.claimOutbox(claim);
    await client.phase4BeginHistoryGap(scopeKey, gap);
    await client.completeOutbox({
      outboxId: leased!.outboxId,
      ownerInstanceId: claim.ownerInstanceId,
    });
    expect(await client.readOutboxStats()).toMatchObject({ delivered: 1, dead: 0 });
    await client.phase4ChangeMemoryPolicy({
      scopeKey,
      expectedGeneration: 0,
      changeId: randomUUID(),
      privacyRevision: "2",
      blocked: true,
      reason: "privacy",
      tombstones: [],
    });
    expect(await confirm(client, f.receipt(1))).toMatchObject({
      outcome: "rejected",
      reason: "privacy_revoked",
    });
  } finally {
    await client.close();
    cleanupTempDataDirectory(dataDirectory);
  }
});

it("rolls back a failed gap receipt and leaves unrelated deliveries claimable", async () => {
  const dataDirectory = createTempDataDirectory("history-gap-rollback-");
  const client = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
  let audit: DatabaseSync | undefined;
  try {
    await client.migrate();
    await client.phase4EnsureMemoryPolicy(scopeKey, "1");
    audit = new DatabaseSync(`${dataDirectory}/state.db`);
    audit.exec(
      "CREATE TRIGGER fail_gap BEFORE INSERT ON phase4_history_gaps BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    await expect(client.phase4BeginHistoryGap(scopeKey, gap)).rejects.toBeDefined();
    expect(await client.phase4ReadMemoryPolicy(scopeKey)).toMatchObject({
      blocked: false,
      generation: 0,
    });
    audit.exec("DROP TRIGGER fail_gap");
    await client.phase4BeginHistoryGap(scopeKey, gap);
    await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 0, trace: TRACE });
    const otherScope = "f".repeat(64);
    await client.phase4EnsureMemoryPolicy(otherScope, "1");
    const policy = { scopeKey: otherScope, generation: 0 };
    const f = fixture("subtitle");
    f.preparation.targets = [{ ...target, policy }];
    await adopt(client, f, 0, policy);
    await client.phase4PrepareEffects(f.preparation);
    await commit(client, f);
    await confirm(client, f.receipt());
    expect(await client.claimOutbox(claim)).toHaveLength(1);
  } finally {
    audit?.close();
    await client.close();
    cleanupTempDataDirectory(dataDirectory);
  }
});
