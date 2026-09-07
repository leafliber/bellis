import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ContextManifestSchema, type MemoryPolicyStamp, type Signal } from "@bellis/contracts";
import { createPersistenceClient, type PersistenceClient } from "../../src/index.js";
import { context } from "../phase4-fixtures.js";
import {
  SESSION_ID,
  TRACE,
  WORKER_FIXTURE,
  createTempDataDirectory,
  cleanupTempDataDirectory,
} from "../helpers.js";

const scopeKey = "e".repeat(64);
const stamp = (generation: number): MemoryPolicyStamp => ({ scopeKey, generation });
const signal = (): Signal => ({
  schemaVersion: 1,
  id: randomUUID(),
  kind: "danmaku",
  source: "trusted",
  occurredAt: 1,
  priority: 1,
  payload: { userId: "viewer", text: "PRIVATE_INPUT" },
  policy: stamp(999),
});
const append = (client: PersistenceClient, item: Signal, policy?: MemoryPolicyStamp) =>
  client.phase3AppendSignal({
    sessionId: SESSION_ID,
    signal: item,
    ...(policy === undefined ? {} : { policy }),
    priorityClass: "normal",
    receivedAtMs: 1,
    normalCapacity: 256,
    urgentCapacity: 32,
    trace: TRACE,
  });
async function initialize(client: PersistenceClient) {
  await client.migrate();
  await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 1, trace: TRACE });
  await client.phase4EnsureMemoryPolicy(scopeKey, "1");
}
async function advance(client: PersistenceClient) {
  await client.phase4ChangeMemoryPolicy({
    scopeKey,
    expectedGeneration: 0,
    changeId: randomUUID(),
    privacyRevision: "2",
    blocked: false,
    reason: "privacy",
    tombstones: [],
  });
}

it("retains original Signal policy through replay and restart, rejects scope escape and unstamped new input", async () => {
  const directory = createTempDataDirectory("phase4-local-inputs");
  let client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
  try {
    await initialize(client);
    const old = signal(),
      fresh = signal(),
      unknown = signal();
    await append(client, old, stamp(0));
    await advance(client);
    await expect(append(client, fresh, stamp(0))).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(append(client, fresh)).rejects.toMatchObject({ code: "invalid_request" });
    expect((await append(client, old, stamp(1))).result).toBe("deduplicated");
    await append(client, fresh, stamp(1));
    const input = {
      sessionId: SESSION_ID,
      policy: stamp(1),
      signalIds: [old.id, fresh.id, unknown.id],
      toolRuns: [],
    };
    const expected = {
      signals: [
        { signalId: old.id, result: "stale_policy" },
        { signalId: fresh.id, result: "included" },
        { signalId: unknown.id, result: "unbound" },
      ],
      tools: [],
    };
    expect(await client.phase4ReadLocalVisibility(input)).toEqual(expected);
    expect(
      (await client.phase4ReadLocalVisibility({ ...input, batchRange: { from: "2", to: "2" } }))
        .aggregatesVisible,
    ).toBe(true);
    for (const batchRange of [
      { from: "1", to: "2" },
      { from: "2", to: "3" },
      { from: "3", to: "2" },
    ])
      expect(
        (await client.phase4ReadLocalVisibility({ ...input, batchRange })).aggregatesVisible,
      ).toBe(false);
    expect((await client.phase3RestoreSignals(SESSION_ID)).pending).toHaveLength(2);
    await client.close();
    client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
    await client.migrate();
    expect(await client.phase4ReadLocalVisibility(input)).toEqual(expected);
    const other = "a".repeat(64);
    await client.phase4EnsureMemoryPolicy(other, "1");
    await expect(
      client.phase4ReadLocalVisibility({ ...input, policy: { scopeKey: other, generation: 0 } }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(
      (await client.phase4ReadLocalVisibility({ ...input, sessionId: randomUUID() })).signals.every(
        (item) => item.result === "unbound",
      ),
    ).toBe(true);
  } finally {
    await client.close();
    cleanupTempDataDirectory(directory);
  }
});

it("rolls Signal acceptance back when its policy metadata cannot be persisted", async () => {
  const directory = createTempDataDirectory("phase4-local-rollback");
  const client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
  let fault: DatabaseSync | undefined;
  try {
    await initialize(client);
    fault = new DatabaseSync(join(directory, "state.db"));
    fault.exec(
      "CREATE TRIGGER fail_signal_policy BEFORE INSERT ON phase4_signal_policy BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    const item = signal();
    await expect(append(client, item, stamp(0))).rejects.toBeDefined();
    expect((await client.phase3RestoreSignals(SESSION_ID)).pending).toHaveLength(0);
    expect(
      (
        await client.phase4ReadLocalVisibility({
          sessionId: SESSION_ID,
          policy: stamp(0),
          signalIds: [item.id],
          toolRuns: [],
        })
      ).signals[0]?.result,
    ).toBe("unbound");
    fault.exec("DROP TRIGGER fail_signal_policy");
    expect(await append(client, item, stamp(0))).toMatchObject({
      result: "accepted",
      sequence: 1n,
    });
  } finally {
    fault?.close();
    await client.close();
    cleanupTempDataDirectory(directory);
  }
});

it("derives Tool Result visibility from its adopted manifest and owner, never from a caller-supplied run name", async () => {
  const directory = createTempDataDirectory("phase4-local-tools");
  let client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
  async function adopt(generation: number) {
    const cycleId = randomUUID(),
      toolRunId = randomUUID(),
      toolName = "memory_search";
    const value = context(cycleId);
    value.manifest.policy = stamp(generation);
    value.manifest.privacyRevision = generation === 0 ? "1" : "2";
    value.manifest = ContextManifestSchema.parse(value.manifest);
    value.manifestDigest = createHash("sha256")
      .update(JSON.stringify(value.manifest))
      .digest("hex");
    await client.phase3AdoptCycle({
      sessionId: SESSION_ID,
      turnId: randomUUID(),
      cycleId,
      cycleIndex: 0,
      batchId: randomUUID(),
      watermarkFrom: 0n,
      watermarkTo: 0n,
      next: "after_tools",
      degraded: false,
      packetDigest: "a".repeat(64),
      context: value,
      toolRuns: [
        {
          toolRunId,
          toolName,
          idempotencyKeyHash: null,
          originalCall: { schemaVersion: 1, toolRunId, toolName, arguments: { query: "tea" } },
        },
      ],
      trace: TRACE,
    });
    return { toolRunId, toolName };
  }
  try {
    await initialize(client);
    const old = await adopt(0);
    await advance(client);
    const current = await adopt(1),
      unknown = { toolRunId: randomUUID(), toolName: "memory_search" };
    const input = {
      sessionId: SESSION_ID,
      policy: stamp(1),
      signalIds: [],
      toolRuns: [old, current, unknown, { ...current, toolName: "forget" }],
    };
    const expected = ["stale_policy", "included", "unbound", "unbound"];
    expect(
      (await client.phase4ReadLocalVisibility(input)).tools.map((item) => item.result),
    ).toEqual(expected);
    await client.close();
    client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
    await client.migrate();
    expect(
      (await client.phase4ReadLocalVisibility(input)).tools.map((item) => item.result),
    ).toEqual(expected);
  } finally {
    await client.close();
    cleanupTempDataDirectory(directory);
  }
});

it("refuses new Signal admission at the policy metadata limit without evicting old records", async () => {
  const directory = createTempDataDirectory("phase4-local-capacity");
  const client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
  let fixture: DatabaseSync | undefined;
  try {
    await initialize(client);
    fixture = new DatabaseSync(join(directory, "state.db"));
    const insert = fixture.prepare("INSERT INTO phase3_signals VALUES (?, ?, ?, 'normal', 1, ?)");
    fixture.exec("BEGIN IMMEDIATE");
    for (let index = 1; index <= 16_384; index++) {
      const item = signal();
      insert.run(SESSION_ID, String(index), item.id, JSON.stringify(item));
    }
    fixture
      .prepare(
        "INSERT INTO phase4_signal_policy SELECT session_id, sequence, ?, 0 FROM phase3_signals",
      )
      .run(scopeKey);
    fixture.exec("COMMIT");
    await expect(
      client.phase3AppendSignal({
        sessionId: SESSION_ID,
        signal: signal(),
        policy: stamp(0),
        priorityClass: "normal",
        receivedAtMs: 2,
        normalCapacity: 20_000,
        urgentCapacity: 32,
        trace: TRACE,
      }),
    ).rejects.toMatchObject({ code: "database_busy" });
    expect(fixture.prepare("SELECT COUNT(*) AS n FROM phase3_signals").get()?.n).toBe(16_384);
    expect(fixture.prepare("SELECT COUNT(*) AS n FROM phase4_signal_policy").get()?.n).toBe(16_384);
  } finally {
    fixture?.close();
    await client.close();
    cleanupTempDataDirectory(directory);
  }
});
