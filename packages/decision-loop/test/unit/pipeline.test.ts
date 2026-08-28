import { describe, expect, it } from "vitest";
import { VirtualClock } from "@bellis/testkit";
import type { AudienceBatch } from "@bellis/contracts";
import { InMemorySignalStore, SignalPipeline } from "../../src/index.js";
import type { TurnOwnerPort } from "../../src/index.js";

const flush = async (): Promise<void> => {
  for (let tick = 0; tick < 8; tick += 1) {
    await Promise.resolve();
  }
};

function setup() {
  const clock = new VirtualClock();
  const store = new InMemorySignalStore({
    normalCapacity: 100,
    urgentCapacity: 20,
    dedupeCapacity: 256,
  });
  const received: { batch: AudienceBatch; trigger: string; atUs: bigint }[] = [];
  const owner: TurnOwnerPort = {
    isIdle: () => true,
    cancelActiveTurn: () => [],
    startTurn: (batch, trigger) => {
      received.push({ batch, trigger, atUs: clock.nowUs() });
      return true;
    },
    mergeIntoNextCycle: () => false,
  };
  let counter = 0;
  const pipeline = new SignalPipeline({
    sessionId: "11111111-1111-4111-8111-111111111111",
    clock,
    wallClockMs: () => 0,
    store,
    owner,
    nextBatchId: () => {
      counter += 1;
      return `${counter.toString(16).padStart(8, "0")}-cccc-4ccc-8ccc-cccccccccccc`;
    },
  });
  return { clock, store, pipeline, received };
}

function signal(id: string, priority: number, text: string): unknown {
  return {
    schemaVersion: 1,
    id,
    kind: "danmaku",
    source: "simulator",
    occurredAt: 0,
    priority,
    payload: { text, userId: "u1" },
  };
}

describe("SignalPipeline", () => {
  it("urgent signals reach the trigger without waiting for the normal window", async () => {
    const { clock, pipeline, received } = setup();
    await pipeline.start();
    // t=0：普通信号打开 200ms 窗口。
    await pipeline.ingest(signal("11111111-1111-4111-8111-111111111111", 100, "普通"));
    // t=50ms：紧急信号必须立即封窗入队（不等 200ms 窗口）。
    clock.advanceBy(50n * 1_000n);
    await flush();
    await pipeline.ingest(signal("22222222-2222-4222-8222-222222222222", 900, "紧急"));
    expect(received.length).toBe(1);
    expect(received[0]?.atUs).toBe(50n * 1_000n);
    expect(received[0]?.trigger).toBe("interrupt");
    expect(received[0]?.batch.urgentSignals).toHaveLength(1);
    await pipeline.close();
  });

  it("closes: window discarded, waiters released, signals remain in store", async () => {
    const { clock, store, pipeline, received } = setup();
    await pipeline.start();
    await pipeline.ingest(signal("11111111-1111-4111-8111-111111111111", 100, "普通"));
    await pipeline.close();
    clock.advanceBy(1_000n * 1_000n);
    await flush();
    // 关闭后不再封窗投递。
    expect(received.length).toBe(0);
    expect(pipeline.isClosed).toBe(true);
    // 未消费信号仍在存储中（重启可恢复）。
    const state = await store.restore();
    expect(state.pending).toHaveLength(1);
  });
});
