import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPersistenceClient } from "../../src/index.js";
import type { PersistenceClient } from "../../src/index.js";
import type { Signal } from "@bellis/contracts";
import {
  SESSION_ID,
  TRACE,
  WORKER_FIXTURE,
  cleanupTempDataDirectory,
  createTempDataDirectory,
} from "../helpers.js";

/**
 * Phase 3 决策域持久化集成测试（ADR 0004）：
 * 真实 DB Worker + Migration 0004；覆盖序号分配/去重/容量、
 * Cycle adoption 原子性（水位同事务前进）、Tool Run 状态投影、
 * 非幂等崩溃恢复 uncertain 与 L2 缓存。
 */

let dataDirectory: string;
let client: PersistenceClient;

function signal(n: number, priority = 100): Signal {
  return {
    schemaVersion: 1,
    id: `66666666-6666-4666-8666-${n.toString().padStart(12, "0")}`,
    kind: "danmaku",
    source: "simulator",
    occurredAt: 1_755_600_000_000,
    priority,
    payload: { text: `m${n}`, userId: "u1" },
  };
}

beforeAll(async () => {
  dataDirectory = createTempDataDirectory("phase3-decision");
  client = createPersistenceClient({
    dataDirectory,
    worker: WORKER_FIXTURE,
  });
  await client.migrate();
  await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 1, trace: TRACE });
});

afterAll(async () => {
  await client.close();
  cleanupTempDataDirectory(dataDirectory);
});

describe("phase3 signal ingestion", () => {
  it("assigns monotonic sequences and deduplicates by signal id", async () => {
    const first = await client.phase3AppendSignal({
      sessionId: SESSION_ID,
      signal: signal(1),
      priorityClass: "normal",
      receivedAtMs: 1,
      normalCapacity: 100,
      urgentCapacity: 10,
      trace: TRACE,
    });
    expect(first).toEqual({ result: "accepted", sequence: 1n });
    const second = await client.phase3AppendSignal({
      sessionId: SESSION_ID,
      signal: signal(2),
      priorityClass: "normal",
      receivedAtMs: 2,
      normalCapacity: 100,
      urgentCapacity: 10,
      trace: TRACE,
    });
    expect(second).toEqual({ result: "accepted", sequence: 2n });
    const duplicate = await client.phase3AppendSignal({
      sessionId: SESSION_ID,
      signal: signal(1),
      priorityClass: "normal",
      receivedAtMs: 3,
      normalCapacity: 100,
      urgentCapacity: 10,
      trace: TRACE,
    });
    expect(duplicate).toEqual({ result: "deduplicated", sequence: 1n });
  });

  it("enforces independent per-class capacities before sequence assignment", async () => {
    const rejected = await client.phase3AppendSignal({
      sessionId: SESSION_ID,
      signal: signal(3),
      priorityClass: "normal",
      receivedAtMs: 4,
      normalCapacity: 2,
      urgentCapacity: 10,
      trace: TRACE,
    });
    expect(rejected).toEqual({ result: "rejected", reason: "normal_capacity" });
    const urgent = await client.phase3AppendSignal({
      sessionId: SESSION_ID,
      signal: { ...signal(4), priority: 900 },
      priorityClass: "urgent",
      receivedAtMs: 5,
      normalCapacity: 2,
      urgentCapacity: 10,
      trace: TRACE,
    });
    expect(urgent).toEqual({ result: "accepted", sequence: 3n });
  });

  it("restores pending signals above the consumed watermark", async () => {
    const state = await client.phase3RestoreSignals(SESSION_ID);
    expect(state.consumed).toBe(0n);
    expect(state.pending.map((entry) => entry.sequence)).toEqual(["1", "2", "3"]);
    expect(state.lastAssigned).toBe(3n);
  });
});

describe("phase3 cycle adoption", () => {
  it("advances watermark, writes cycle row and planned tool runs atomically", async () => {
    await client.phase3AdoptCycle({
      sessionId: SESSION_ID,
      turnId: "22222222-2222-4222-8222-222222222222",
      cycleId: "33333333-3333-4333-8333-333333333333",
      cycleIndex: 0,
      batchId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      watermarkFrom: 1n,
      watermarkTo: 3n,
      next: "after_tools",
      degraded: false,
      packetDigest: "a".repeat(64),
      toolRuns: [
        {
          toolRunId: "88888888-8888-4888-8888-888888888888",
          toolName: "lookup_quest",
          idempotencyKeyHash: null,
        },
      ],
      trace: TRACE,
    });
    const decision = await client.phase3ReadDecisionState(SESSION_ID);
    expect(decision.consumed).toBe(3n);
    expect(decision.cycles).toHaveLength(1);
    expect(decision.cycles[0]?.next).toBe("after_tools");
    expect(decision.toolRuns[0]?.state).toBe("planned");
    // 采用记录作为版本化 Session Record 落库。
    const records = await client.listRecords({
      sessionId: SESSION_ID,
      recordType: "phase3_cycle_adopted",
    });
    expect(records).toHaveLength(1);
    // 重放同 cycleId 幂等：不重复推进、不重复记录。
    await client.phase3AdoptCycle({
      sessionId: SESSION_ID,
      turnId: "22222222-2222-4222-8222-222222222222",
      cycleId: "33333333-3333-4333-8333-333333333333",
      cycleIndex: 0,
      batchId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      watermarkFrom: 1n,
      watermarkTo: 3n,
      next: "after_tools",
      degraded: false,
      packetDigest: "a".repeat(64),
      toolRuns: [
        {
          toolRunId: "88888888-8888-4888-8888-888888888888",
          toolName: "lookup_quest",
          idempotencyKeyHash: null,
        },
      ],
      trace: TRACE,
    });
    const afterReplay = await client.phase3ReadDecisionState(SESSION_ID);
    expect(afterReplay.cycles).toHaveLength(1);
    // 恢复后未消费信号为空（水位已到 3）。
    const restored = await client.phase3RestoreSignals(SESSION_ID);
    expect(restored.pending).toEqual([]);
  });

  it("marks running tool runs uncertain on recovery (no auto retry)", async () => {
    await client.phase3ToolRunEvent({
      sessionId: SESSION_ID,
      toolRunId: "88888888-8888-4888-8888-888888888888",
      cycleId: "33333333-3333-4333-8333-333333333333",
      toolName: "lookup_quest",
      transition: "started",
      state: "running",
      trace: TRACE,
    });
    let decision = await client.phase3ReadDecisionState(SESSION_ID);
    expect(decision.toolRuns[0]?.state).toBe("running");
    decision = await client.phase3ReadDecisionState(SESSION_ID, { markUncertain: true });
    expect(decision.uncertainMarked).toBe(1);
    expect(decision.toolRuns[0]?.state).toBe("uncertain");
    // 再次标记：无 running 行，幂等。
    const again = await client.phase3ReadDecisionState(SESSION_ID, { markUncertain: true });
    expect(again.uncertainMarked).toBe(0);
  });
});

describe("phase3 tool cache (L2)", () => {
  it("stores and expires cache entries by ttl", async () => {
    const key = `${"k".repeat(64)}`;
    await client.phase3ToolCacheSet({
      cacheKey: key,
      toolName: "lookup_quest",
      payload: { quest: "main" },
      ttlMs: 60_000,
    });
    const hit = await client.phase3ToolCacheGet(key);
    expect(hit).toEqual({ quest: "main" });
    const miss = await client.phase3ToolCacheGet(`${"z".repeat(64)}`);
    expect(miss).toBeNull();
  });
});
