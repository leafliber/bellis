import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createPersistenceClient, type Phase3AdoptCycleInput } from "../../src/index.js";
import { ToolCallSchema, type ToolCall } from "@bellis/contracts";
import {
  SESSION_ID,
  TRACE,
  WORKER_FIXTURE,
  createTempDataDirectory,
  cleanupTempDataDirectory,
} from "../helpers.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const call = (): ToolCall => ({
  schemaVersion: 1,
  toolRunId: randomUUID(),
  toolName: "remember",
  arguments: { text: "private fact 🐈", nested: { version: "9007199254740993" } },
  idempotencyKey: "original-business-key",
});
function adoption(originalCall: ToolCall): Phase3AdoptCycleInput & { trace: typeof TRACE } {
  return {
    sessionId: SESSION_ID,
    turnId: randomUUID(),
    cycleId: randomUUID(),
    cycleIndex: 0,
    batchId: randomUUID(),
    watermarkFrom: 1n,
    watermarkTo: 1n,
    next: "after_tools",
    degraded: false,
    packetDigest: "a".repeat(64),
    toolRuns: [
      {
        toolRunId: originalCall.toolRunId,
        toolName: originalCall.toolName,
        idempotencyKeyHash: hash(originalCall.idempotencyKey!),
        originalCall,
      },
    ],
    trace: TRACE,
  };
}

it("recovers the exact original call after Worker restart without disclosing it in audit or replaying it", async () => {
  const dataDirectory = createTempDataDirectory("phase4-tool-calls-");
  let client = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
  try {
    await client.migrate();
    await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 1, trace: TRACE });
    const original = call();
    const input = adoption(original);
    await client.phase3AdoptCycle(input);
    await client.phase3ToolRunEvent({
      sessionId: SESSION_ID,
      toolRunId: original.toolRunId,
      cycleId: input.cycleId,
      toolName: original.toolName,
      transition: "started",
      state: "running",
      trace: TRACE,
    });
    await client.close();
    client = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
    await client.migrate();
    const state = await client.phase3ReadDecisionState(SESSION_ID, { markUncertain: true });
    expect(state.uncertainMarked).toBe(1);
    expect(state.toolRuns[0]?.state).toBe("uncertain");
    expect(await client.phase4ReadToolCall(SESSION_ID, original.toolRunId)).toEqual(original);
    expect(await client.phase4ReadToolCall(randomUUID(), original.toolRunId)).toBeNull();
    await client.phase3AdoptCycle(input); // Lost adoption ACK retains one original invocation.
    for (const changed of [
      { ...original, arguments: { text: "different" } },
      { ...original, idempotencyKey: "new-key" },
    ]) {
      await expect(
        client.phase3AdoptCycle({
          ...input,
          toolRuns: [{ ...input.toolRuns[0]!, originalCall: ToolCallSchema.parse(changed) }],
        }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
    }
    await expect(client.phase3AdoptCycle({ ...input, toolRuns: [] })).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    await expect(
      client.phase3AdoptCycle({
        ...input,
        toolRuns: [
          {
            toolRunId: original.toolRunId,
            toolName: original.toolName,
            idempotencyKeyHash: hash(original.idempotencyKey!),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    const audit = JSON.stringify(await client.listRecords({ sessionId: SESSION_ID }));
    expect(audit).not.toContain("private fact");
    expect(audit).not.toContain(original.idempotencyKey);
    expect(await client.phase4ReadToolCall(SESSION_ID, original.toolRunId)).toEqual(original);
  } finally {
    await client.close();
    cleanupTempDataDirectory(dataDirectory);
  }
});

it("rolls back the entire adoption when original call identity, key hash, or size is invalid", async () => {
  const dataDirectory = createTempDataDirectory("phase4-tool-call-rollback-");
  const client = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
  try {
    await client.migrate();
    await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 1, trace: TRACE });
    const original = call();
    const input = adoption(original);
    for (const changed of [
      { ...original, toolName: "forget" },
      { ...original, toolRunId: randomUUID() },
      { ...original, idempotencyKey: "changed-key" },
      { ...original, arguments: { text: "x".repeat(65_536) } },
    ]) {
      await expect(
        client.phase3AdoptCycle({
          ...input,
          toolRuns: [{ ...input.toolRuns[0]!, originalCall: ToolCallSchema.parse(changed) }],
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(await client.phase3ReadDecisionState(SESSION_ID)).toMatchObject({
        consumed: 0n,
        cycles: [],
        toolRuns: [],
      });
      expect(await client.phase4ReadToolCall(SESSION_ID, original.toolRunId)).toBeNull();
    }
    const { originalCall: _, ...legacy } = input.toolRuns[0]!;
    await client.phase3AdoptCycle({ ...input, toolRuns: [legacy] });
    expect(await client.phase4ReadToolCall(SESSION_ID, original.toolRunId)).toBeNull();
  } finally {
    await client.close();
    cleanupTempDataDirectory(dataDirectory);
  }
});
