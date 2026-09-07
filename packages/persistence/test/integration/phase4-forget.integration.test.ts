import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ToolCallSchema, type PreparedToolCall, type MemoryForgetReceipt } from "@bellis/contracts";
import { createPersistenceClient, type PersistenceClient } from "../../src/index.js";
import {
  SESSION_ID,
  TRACE,
  WORKER_FIXTURE,
  createTempDataDirectory,
  cleanupTempDataDirectory,
} from "../helpers.js";

const scopeKey = "d".repeat(64);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const erased: MemoryForgetReceipt = {
  requestId: "core-forget",
  targetCount: 1,
  erasedCount: 1,
  protectedSkipped: 0,
  heldSkipped: 0,
};
async function prepare(client: PersistenceClient): Promise<PreparedToolCall> {
  await client.migrate();
  await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 1, trace: TRACE });
  await client.phase4EnsureMemoryPolicy(scopeKey, "1");
  const call = ToolCallSchema.parse({
    schemaVersion: 1,
    toolRunId: randomUUID(),
    toolName: "forget",
    arguments: { claimId: "claim" },
  });
  const turnId = randomUUID(),
    cycleId = randomUUID();
  await client.phase3AdoptCycle({
    sessionId: SESSION_ID,
    turnId,
    cycleId,
    cycleIndex: 0,
    batchId: randomUUID(),
    watermarkFrom: 1n,
    watermarkTo: 1n,
    next: "after_tools",
    degraded: false,
    packetDigest: "a".repeat(64),
    toolRuns: [
      {
        toolRunId: call.toolRunId,
        toolName: "forget",
        idempotencyKeyHash: null,
        originalCall: call,
      },
    ],
    trace: TRACE,
  });
  const prepared: PreparedToolCall = {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    turnId,
    cycleId,
    toolRunId: call.toolRunId,
    toolName: "forget",
    toolVersion: 1,
    originalCallDigest: hash(JSON.stringify(call)),
    providerId: "iris",
    idempotencyKey: "original-key",
    request: { operation: "forget", claimId: "claim" },
    confirmation: { target: "claim" },
    policy: { scopeKey, generation: 0 },
    resources: [{ ref: "iris:claim:claim", revision: "7" }],
  };
  await client.phase4SavePreparedTool(prepared);
  return prepared;
}

it("atomically persists the Forget barrier, survives Worker restart, then commits receipt and permanent tombstone", async () => {
  const directory = createTempDataDirectory("phase4-forget-recovery-");
  let client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
  try {
    const prepared = await prepare(client);
    const started = await client.phase4BeginMemoryForget(SESSION_ID, prepared.toolRunId);
    expect(started).toMatchObject({
      operation: { state: "blocked", receipt: null, barrierGeneration: 1 },
      policy: { blocked: true, generation: 1 },
    });
    await expect(client.phase4SavePreparedTool(prepared)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await client.close();
    client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
    await client.migrate();
    expect(await client.phase4ReadMemoryForget(SESSION_ID, prepared.toolRunId)).toEqual(
      started.operation,
    );
    expect(await client.phase4ReadPreparedTool(SESSION_ID, prepared.toolRunId)).toEqual(prepared);
    expect(await client.phase4BeginMemoryForget(SESSION_ID, prepared.toolRunId)).toEqual(started);
    const completed = await client.phase4CompleteMemoryForget({
      sessionId: SESSION_ID,
      toolRunId: prepared.toolRunId,
      receipt: erased,
    });
    expect(completed).toMatchObject({
      operation: { state: "resolved", receipt: erased },
      policy: {
        blocked: false,
        generation: 2,
        tombstones: [
          { providerId: "iris", resourceRef: "iris:claim:claim", throughRevision: null },
        ],
      },
    });
    expect(
      await client.phase4CompleteMemoryForget({
        sessionId: SESSION_ID,
        toolRunId: prepared.toolRunId,
        receipt: erased,
      }),
    ).toEqual(completed);
    await expect(
      client.phase4CompleteMemoryForget({
        sessionId: SESSION_ID,
        toolRunId: prepared.toolRunId,
        receipt: { ...erased, requestId: "different" },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      client.phase4BeginMemoryForget(SESSION_ID, prepared.toolRunId),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(await client.phase4ReadMemoryForget(randomUUID(), prepared.toolRunId)).toBeNull();
  } finally {
    await client.close();
    cleanupTempDataDirectory(directory);
  }
});

it("retains the read barrier and exact receipt when Core holds, protects, or does not erase every target", async () => {
  for (const receipt of [
    { ...erased, erasedCount: 0, heldSkipped: 1 },
    { ...erased, erasedCount: 0, protectedSkipped: 1 },
    { ...erased, erasedCount: 0 },
  ]) {
    const directory = createTempDataDirectory("phase4-forget-retained-");
    const client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
    try {
      const prepared = await prepare(client);
      await client.phase4BeginMemoryForget(SESSION_ID, prepared.toolRunId);
      const result = await client.phase4CompleteMemoryForget({
        sessionId: SESSION_ID,
        toolRunId: prepared.toolRunId,
        receipt,
      });
      expect(result).toMatchObject({
        operation: { state: "retained", receipt },
        policy: { blocked: true, generation: 2, tombstones: [] },
      });
      expect(
        await client.phase4CompleteMemoryForget({
          sessionId: SESSION_ID,
          toolRunId: prepared.toolRunId,
          receipt,
        }),
      ).toEqual(result);
    } finally {
      await client.close();
      cleanupTempDataDirectory(directory);
    }
  }
});

it("never releases a newer privacy barrier when an older Forget success arrives", async () => {
  const directory = createTempDataDirectory("phase4-forget-new-policy-");
  const client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
  try {
    const prepared = await prepare(client);
    await client.phase4BeginMemoryForget(SESSION_ID, prepared.toolRunId);
    await client.phase4ChangeMemoryPolicy({
      scopeKey,
      expectedGeneration: 1,
      changeId: randomUUID(),
      privacyRevision: "new-privacy",
      blocked: true,
      reason: "privacy",
      tombstones: [],
    });
    await expect(
      client.phase4BeginMemoryForget(SESSION_ID, prepared.toolRunId),
    ).rejects.toMatchObject({ code: "invalid_request" });
    const result = await client.phase4CompleteMemoryForget({
      sessionId: SESSION_ID,
      toolRunId: prepared.toolRunId,
      receipt: erased,
    });
    expect(result).toMatchObject({
      operation: { state: "resolved" },
      policy: {
        blocked: true,
        generation: 3,
        privacyRevision: "new-privacy",
        tombstones: [
          { providerId: "iris", resourceRef: "iris:claim:claim", throughRevision: null },
        ],
      },
    });
  } finally {
    await client.close();
    cleanupTempDataDirectory(directory);
  }
});

it("rejects missing preparation, receipt without a barrier and impossible counts without changing policy", async () => {
  const directory = createTempDataDirectory("phase4-forget-invalid-");
  const client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
  try {
    const prepared = await prepare(client);
    await expect(client.phase4BeginMemoryForget(SESSION_ID, randomUUID())).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      client.phase4CompleteMemoryForget({
        sessionId: SESSION_ID,
        toolRunId: prepared.toolRunId,
        receipt: erased,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(await client.phase4ReadMemoryPolicy(scopeKey)).toMatchObject({
      generation: 0,
      blocked: false,
    });
    expect(await client.phase4ReadMemoryForget(SESSION_ID, prepared.toolRunId)).toBeNull();
    await client.phase4BeginMemoryForget(SESSION_ID, prepared.toolRunId);
    await expect(
      client.phase4CompleteMemoryForget({
        sessionId: SESSION_ID,
        toolRunId: prepared.toolRunId,
        receipt: { ...erased, heldSkipped: 1 },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(await client.phase4ReadMemoryForget(SESSION_ID, prepared.toolRunId)).toMatchObject({
      state: "blocked",
      receipt: null,
    });
    expect(await client.phase4ReadMemoryPolicy(scopeKey)).toMatchObject({
      generation: 1,
      blocked: true,
    });
  } finally {
    await client.close();
    cleanupTempDataDirectory(directory);
  }
});

it("rolls back policy and tombstones if the durable Forget operation record cannot be written", async () => {
  const directory = createTempDataDirectory("phase4-forget-atomic-");
  const client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
  let fault: DatabaseSync | undefined;
  try {
    const prepared = await prepare(client);
    // Inject a failure in Bellis's own temporary DB, after the policy update in the same transaction.
    fault = new DatabaseSync(join(directory, "state.db"));
    fault.exec(
      "CREATE TRIGGER reject_forget_insert BEFORE INSERT ON phase4_memory_forget BEGIN SELECT RAISE(ABORT, 'injected record failure'); END",
    );
    await expect(client.phase4BeginMemoryForget(SESSION_ID, prepared.toolRunId)).rejects.toThrow();
    expect(await client.phase4ReadMemoryPolicy(scopeKey)).toMatchObject({
      generation: 0,
      blocked: false,
    });
    expect(await client.phase4ReadMemoryForget(SESSION_ID, prepared.toolRunId)).toBeNull();
    fault.exec("DROP TRIGGER reject_forget_insert");
    await client.phase4BeginMemoryForget(SESSION_ID, prepared.toolRunId);
    fault.exec(
      "CREATE TRIGGER reject_forget_update BEFORE UPDATE ON phase4_memory_forget BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END",
    );
    await expect(
      client.phase4CompleteMemoryForget({
        sessionId: SESSION_ID,
        toolRunId: prepared.toolRunId,
        receipt: erased,
      }),
    ).rejects.toThrow();
    expect(await client.phase4ReadMemoryPolicy(scopeKey)).toMatchObject({
      generation: 1,
      blocked: true,
      tombstones: [],
    });
    expect(await client.phase4ReadMemoryForget(SESSION_ID, prepared.toolRunId)).toMatchObject({
      state: "blocked",
      receipt: null,
    });
    fault.exec("DROP TRIGGER reject_forget_update");
    expect(
      (
        await client.phase4CompleteMemoryForget({
          sessionId: SESSION_ID,
          toolRunId: prepared.toolRunId,
          receipt: erased,
        })
      ).operation.state,
    ).toBe("resolved");
  } finally {
    fault?.close();
    await client.close();
    cleanupTempDataDirectory(directory);
  }
});
