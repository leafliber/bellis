import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MemoryInputObservation } from "@bellis/contracts";
import { createPersistenceClient } from "../../src/index.js";
import {
  SESSION_ID,
  TRACE,
  WORKER_FIXTURE,
  cleanupTempDataDirectory,
  createTempDataDirectory,
} from "../helpers.js";

const target: MemoryInputObservation = {
  providerId: "iris",
  agentId: "agent",
  spaceId: "space",
  actorExternalIdentityId: "trusted",
  sourceStream: "input:one",
  role: "user",
  content: "实际收到的内容",
  privacyLabels: ["space:space"],
};
function input(observations: MemoryInputObservation[] = [target]) {
  return {
    sessionId: SESSION_ID,
    signal: {
      schemaVersion: 1 as const,
      id: randomUUID(),
      source: "trusted-chat",
      kind: "chat.message",
      occurredAt: 1,
      priority: 0,
      payload: { text: "actual" },
    },
    priorityClass: "normal" as const,
    receivedAtMs: 2,
    normalCapacity: 100,
    urgentCapacity: 10,
    observations,
    trace: TRACE,
  };
}
const claim = { limit: 100, leaseMs: 30_000, ownerInstanceId: "a2-test" };

describe("Phase 4 durable input Observe", () => {
  it("rejects obsolete or missing policy stamps and starts a new stream after privacy invalidation", async () => {
    const directory = createTempDataDirectory("phase4-input-policy");
    const client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
    const scopeKey = "e".repeat(64);
    try {
      await client.migrate();
      await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 0, trace: TRACE });
      await client.phase4EnsureMemoryPolicy(scopeKey, "1");
      const old = { ...target, policy: { scopeKey, generation: 0 } };
      await client.phase3AppendSignal(input([old]));
      await client.phase4ChangeMemoryPolicy({
        scopeKey,
        expectedGeneration: 0,
        changeId: randomUUID(),
        privacyRevision: "1",
        blocked: false,
        reason: "privacy",
        tombstones: [],
      });
      await expect(client.phase3AppendSignal(input([old]))).rejects.toMatchObject({
        code: "invalid_request",
      });
      await expect(client.phase3AppendSignal(input([target]))).rejects.toMatchObject({
        code: "invalid_request",
      });
      expect(await client.claimOutbox(claim)).toEqual([]);
      const fresh = {
        ...target,
        sourceStream: "input:one:policy:1",
        policy: { scopeKey, generation: 1 },
      };
      expect(await client.phase3AppendSignal(input([fresh]))).toMatchObject({
        result: "accepted",
        sequence: 2n,
      });
      const messages = await client.claimOutbox(claim);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.payload).toMatchObject({
        policy: { scopeKey, generation: 1 },
        event: { sourceStream: fresh.sourceStream, sourceCursor: "1" },
      });
    } finally {
      await client.close();
      cleanupTempDataDirectory(directory);
    }
  });

  it("allocates independent gap-free cursors, deduplicates inputs, and only claims each stream head", async () => {
    const directory = createTempDataDirectory("phase4-observe");
    const client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
    try {
      await client.migrate();
      await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 0, trace: TRACE });
      // Accepted signals that have no trusted identity are not observations.
      await client.phase3AppendSignal(input([]));
      const first = input();
      expect(await client.phase3AppendSignal(first)).toEqual({ result: "accepted", sequence: 2n });
      expect(
        await client.phase3AppendSignal({
          ...first,
          observations: [{ ...target, content: "changed replay" }],
        }),
      ).toEqual({ result: "deduplicated", sequence: 2n });
      await client.phase3AppendSignal(input());
      await client.phase3AppendSignal(input([{ ...target, sourceStream: "input:other" }]));
      const heads = await client.claimOutbox(claim);
      expect(heads).toHaveLength(2);
      for (const head of heads)
        expect(head.payload).toMatchObject({
          event: { sourceCursor: "1", content: target.content, effectState: "committed" },
        });
      // An in-flight head, including a different dispatcher's lease, blocks its successor.
      expect(await client.claimOutbox({ ...claim, ownerInstanceId: "another-dispatcher" })).toEqual(
        [],
      );
      for (const head of heads) await client.completeOutbox({ ...claim, outboxId: head.outboxId });
      const second = await client.claimOutbox(claim);
      expect(second).toHaveLength(1);
      expect(second[0]!.payload).toMatchObject({
        event: { sourceCursor: "2", sourceStream: "input:one" },
      });
      expect((await client.phase3ReadDecisionState(SESSION_ID)).consumed).toBe(0n);
    } finally {
      await client.close();
      cleanupTempDataDirectory(directory);
    }
  });

  it("replays the identical event after remote acceptance before local ACK, with no cursor gaps after restart", async () => {
    const directory = createTempDataDirectory("phase4-observe-recovery");
    let client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
    try {
      await client.migrate();
      await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 0, trace: TRACE });
      await client.phase3AppendSignal(input());
      await client.phase3AppendSignal(input());
      const before = (await client.claimOutbox(claim))[0]!;
      // Remote might already have accepted this message. No local completion is written.
      await client.close();
      client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
      await client.migrate();
      const retry = await client.claimOutbox(claim);
      expect(retry).toEqual([before]);
      await expect(
        client.completeOutbox({ outboxId: before.outboxId, ownerInstanceId: "wrong-owner" }),
      ).rejects.toMatchObject({ code: "not_claimed" });
      await client.completeOutbox({
        outboxId: before.outboxId,
        ownerInstanceId: claim.ownerInstanceId,
      });
      await client.completeOutbox({
        outboxId: before.outboxId,
        ownerInstanceId: claim.ownerInstanceId,
      });
      const next = (await client.claimOutbox(claim))[0]!;
      expect(next.payload).toMatchObject({ event: { sourceCursor: "2" } });
      // Poison/dead letters keep the stream stopped; an unrelated stream still progresses.
      await client.retryOutbox({
        outboxId: next.outboxId,
        ownerInstanceId: claim.ownerInstanceId,
        errorCode: "revoked",
        retryable: false,
      });
      await client.phase3AppendSignal(input());
      await client.phase3AppendSignal(input([{ ...target, sourceStream: "other" }]));
      const other = await client.claimOutbox(claim);
      expect(other).toHaveLength(1);
      expect(other[0]!.payload).toMatchObject({
        event: { sourceStream: "other", sourceCursor: "1" },
      });
    } finally {
      await client.close();
      cleanupTempDataDirectory(directory);
    }
  });

  it("rolls back accepted Signal and cursor allocation if any observation cannot be committed", async () => {
    const directory = createTempDataDirectory("phase4-observe-rollback");
    const client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
    try {
      await client.migrate();
      await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 0, trace: TRACE });
      const invalid = input([target, { ...target }]);
      await expect(client.phase3AppendSignal(invalid)).rejects.toMatchObject({
        code: "invalid_request",
      });
      expect((await client.phase3RestoreSignals(SESSION_ID)).lastAssigned).toBe(0n);
      expect((await client.readOutboxStats()).pending).toBe(0);
      const future = input();
      future.signal.occurredAt = 3;
      await expect(client.phase3AppendSignal(future)).rejects.toMatchObject({
        code: "invalid_request",
      });
      expect(await client.phase3AppendSignal(input())).toMatchObject({ sequence: 1n });
      expect((await client.claimOutbox(claim))[0]!.payload).toMatchObject({
        event: { sourceCursor: "1" },
      });
    } finally {
      await client.close();
      cleanupTempDataDirectory(directory);
    }
  });
});
