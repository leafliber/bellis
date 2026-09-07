import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { type PreparedToolCall, ToolCallSchema } from "@bellis/contracts";
import { createPersistenceClient } from "../../src/index.js";
import {
  SESSION_ID,
  TRACE,
  WORKER_FIXTURE,
  createTempDataDirectory,
  cleanupTempDataDirectory,
} from "../helpers.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture() {
  const originalCall = ToolCallSchema.parse({
    schemaVersion: 1,
    toolRunId: randomUUID(),
    toolName: "correct",
    arguments: { target: "tea", value: "green" },
    idempotencyKey: "model-key",
  });
  const adoption = {
    sessionId: SESSION_ID,
    turnId: randomUUID(),
    cycleId: randomUUID(),
    cycleIndex: 0,
    batchId: randomUUID(),
    watermarkFrom: 1n,
    watermarkTo: 1n,
    next: "after_tools" as const,
    degraded: false,
    packetDigest: "a".repeat(64),
    trace: TRACE,
    toolRuns: [
      {
        toolRunId: originalCall.toolRunId,
        toolName: originalCall.toolName,
        idempotencyKeyHash: hash(originalCall.idempotencyKey!),
        originalCall,
      },
    ],
  };
  const prepared: PreparedToolCall = {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    turnId: adoption.turnId,
    cycleId: adoption.cycleId,
    toolRunId: originalCall.toolRunId,
    toolName: originalCall.toolName,
    toolVersion: 1,
    originalCallDigest: hash(JSON.stringify(originalCall)),
    providerId: "iris",
    idempotencyKey: "trusted-business-key",
    request: {
      claim_id: "resolved-claim",
      expected_revision: 7,
      value: "green",
      agent_id: "trusted-agent",
    },
    confirmation: { action: "correct", target: "resolved-claim", value: "green" },
    resources: [{ ref: "iris:claim:resolved-claim", revision: "7" }],
  };
  return { adoption, prepared };
}

it("retains the exact prepared request across Worker restart and rejects replacement keys or parameters", async () => {
  const directory = createTempDataDirectory("phase4-prepared-recovery-");
  let client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
  try {
    await client.migrate();
    await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 1, trace: TRACE });
    const { adoption, prepared } = fixture();
    await client.phase3AdoptCycle(adoption);
    await client.phase4SavePreparedTool(prepared);
    await client.close();
    client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
    await client.migrate();
    expect(await client.phase4ReadPreparedTool(SESSION_ID, prepared.toolRunId)).toEqual(prepared);
    await client.phase4SavePreparedTool(prepared);
    for (const changed of [
      { ...prepared, idempotencyKey: "replacement-key" },
      { ...prepared, request: { expected_revision: 8 } },
      { ...prepared, confirmation: { target: "different-target" } },
    ])
      await expect(client.phase4SavePreparedTool(changed)).rejects.toMatchObject({
        code: "idempotency_conflict",
      });
    expect(await client.phase4ReadPreparedTool(randomUUID(), prepared.toolRunId)).toBeNull();
    expect(await client.phase4ReadPreparedTool(SESSION_ID, prepared.toolRunId)).toEqual(prepared);
    const audit = JSON.stringify(await client.listRecords({ sessionId: SESSION_ID }));
    expect(audit).not.toContain("trusted-business-key");
    expect(audit).not.toContain("resolved-claim");
  } finally {
    await client.close();
    cleanupTempDataDirectory(directory);
  }
});

it("requires the adopted original identity and rolls back invalid or oversized preparation", async () => {
  const directory = createTempDataDirectory("phase4-prepared-invalid-");
  const client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
  try {
    await client.migrate();
    await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 1, trace: TRACE });
    const { adoption, prepared } = fixture();
    await expect(client.phase4SavePreparedTool(prepared)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await client.phase3AdoptCycle(adoption);
    for (const changed of [
      { ...prepared, originalCallDigest: "b".repeat(64) },
      { ...prepared, turnId: randomUUID() },
      { ...prepared, cycleId: randomUUID() },
      { ...prepared, toolName: "forget" },
      { ...prepared, request: { text: "x".repeat(65_536) } },
    ]) {
      await expect(client.phase4SavePreparedTool(changed)).rejects.toMatchObject({
        code: "invalid_request",
      });
      expect(await client.phase4ReadPreparedTool(SESSION_ID, prepared.toolRunId)).toBeNull();
    }
    await client.phase4SavePreparedTool(prepared);
    const legacy = fixture();
    const { originalCall: _, ...run } = legacy.adoption.toolRuns[0]!;
    await client.phase3AdoptCycle({
      ...legacy.adoption,
      watermarkFrom: 2n,
      watermarkTo: 2n,
      toolRuns: [run],
    });
    await expect(client.phase4SavePreparedTool(legacy.prepared)).rejects.toMatchObject({
      code: "invalid_request",
    });
  } finally {
    await client.close();
    cleanupTempDataDirectory(directory);
  }
});

it("revalidates privacy on exact retry while keeping historical requests available for reconciliation", async () => {
  const directory = createTempDataDirectory("phase4-prepared-policy-");
  const client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
  try {
    await client.migrate();
    await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 1, trace: TRACE });
    const { adoption, prepared } = fixture();
    const scopeKey = "d".repeat(64);
    await client.phase4EnsureMemoryPolicy(scopeKey, "1");
    await client.phase3AdoptCycle(adoption);
    const next = fixture();
    await client.phase3AdoptCycle({ ...next.adoption, watermarkFrom: 2n, watermarkTo: 2n });
    prepared.policy = { scopeKey, generation: 0 };
    await client.phase4SavePreparedTool(prepared);
    await client.phase4ChangeMemoryPolicy({
      scopeKey,
      expectedGeneration: 0,
      changeId: randomUUID(),
      privacyRevision: "2",
      blocked: false,
      reason: "resource-invalidated",
      tombstones: [
        { providerId: "iris", resourceRef: "iris:claim:resolved-claim", throughRevision: "7" },
      ],
    });
    await expect(client.phase4SavePreparedTool(prepared)).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(await client.phase4ReadPreparedTool(SESSION_ID, prepared.toolRunId)).toEqual(prepared);
    await expect(client.phase4SavePreparedTool(next.prepared)).rejects.toMatchObject({
      code: "invalid_request",
    });
    next.prepared.policy = { scopeKey, generation: 1 };
    await expect(client.phase4SavePreparedTool(next.prepared)).rejects.toMatchObject({
      code: "invalid_request",
    });
    next.prepared.resources = [{ ref: "iris:claim:resolved-claim", revision: "8" }];
    const otherScope = "f".repeat(64);
    await client.phase4EnsureMemoryPolicy(otherScope, "1");
    await expect(
      client.phase4SavePreparedTool({
        ...next.prepared,
        policy: { scopeKey: otherScope, generation: 0 },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await client.phase4SavePreparedTool(next.prepared);
    await client.phase4ChangeMemoryPolicy({
      scopeKey,
      expectedGeneration: 1,
      changeId: randomUUID(),
      privacyRevision: "3",
      blocked: true,
      reason: "privacy",
      tombstones: [],
    });
    await expect(client.phase4SavePreparedTool(next.prepared)).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(await client.phase4ReadPreparedTool(SESSION_ID, next.prepared.toolRunId)).toEqual(
      next.prepared,
    );
  } finally {
    await client.close();
    cleanupTempDataDirectory(directory);
  }
});
