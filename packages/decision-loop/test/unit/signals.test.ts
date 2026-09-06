import { describe, expect, it } from "vitest";
import type { Signal } from "@bellis/contracts";
import { InMemorySignalStore, SignalIngress } from "../../src/index.js";
import type { IngestedSignal } from "@bellis/contracts";

function signal(id: string, priority = 100, payload: Signal["payload"] = { text: "冲" }): Signal {
  return {
    schemaVersion: 1,
    id,
    kind: "danmaku",
    source: "simulator",
    occurredAt: 1_755_600_000_000,
    priority,
    payload,
  };
}

function makeIngest(capacity = { normalCapacity: 4, urgentCapacity: 2, dedupeCapacity: 16 }) {
  const store = new InMemorySignalStore(capacity);
  const delivered: IngestedSignal[] = [];
  const ingress = new SignalIngress({
    store,
    policy: { urgentPriorityThreshold: 800, urgentKinds: ["moderator_command"] },
    wallClockMs: () => 1_755_600_000_123,
    sink: (ingested) => delivered.push(ingested),
  });
  return { store, ingress, delivered };
}
describe("SignalIngress", () => {
  it("accepts valid signals and assigns monotonic sequences in delivery order", async () => {
    const { ingress, delivered } = makeIngest();
    const first = await ingress.ingest(signal("11111111-1111-4111-8111-111111111111"));
    const second = await ingress.ingest(signal("22222222-2222-4222-8222-222222222222"));
    expect(first).toMatchObject({ result: "accepted", sequence: 1n });
    expect(second).toMatchObject({ result: "accepted", sequence: 2n });
    expect(delivered.map((entry) => entry.priorityClass)).toEqual(["normal", "normal"]);
  });

  it("rejects invalid signals without consuming a sequence", async () => {
    const { ingress } = makeIngest();
    const rejected = await ingress.ingest({ hello: "world" });
    expect(rejected).toEqual({ result: "rejected", reason: "invalid_signal" });
    const accepted = await ingress.ingest(signal("11111111-1111-4111-8111-111111111111"));
    expect(accepted).toMatchObject({ result: "accepted", sequence: 1n });
  });

  it("deduplicates by signal id and echoes the original sequence", async () => {
    const { ingress, delivered } = makeIngest();
    const id = "11111111-1111-4111-8111-111111111111";
    await ingress.ingest(signal(id));
    const duplicate = await ingress.ingest(signal(id, 100, { text: "重发" }));
    expect(duplicate).toEqual({ result: "deduplicated", sequence: 1n, priorityClass: "normal" });
    expect(delivered.length).toBe(1);
  });

  it("keeps identical IDs from different sources and deduplicates source retries", async () => {
    const { ingress, delivered } = makeIngest();
    const first = signal("11111111-1111-4111-8111-111111111111");
    await ingress.ingest(first);
    const second = { ...first, source: "another-platform" };
    expect(await ingress.ingest(second)).toMatchObject({ result: "accepted", sequence: 2n });
    expect(await ingress.ingest(second)).toMatchObject({ result: "deduplicated", sequence: 2n });
    expect(delivered).toHaveLength(2);
  });

  it("classifies urgent by threshold and kind directory", async () => {
    const { ingress, delivered } = makeIngest();
    await ingress.ingest(signal("11111111-1111-4111-8111-111111111111", 900));
    await ingress.ingest({
      ...signal("22222222-2222-4222-8222-222222222222"),
      kind: "moderator_command",
    });
    expect(delivered.map((entry) => entry.priorityClass)).toEqual(["urgent", "urgent"]);
  });

  it("enforces independent normal and urgent capacities before sequence assignment", async () => {
    const { store, ingress } = makeIngest();
    for (let index = 0; index < 4; index += 1) {
      const result = await ingress.ingest(
        signal(`${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`),
      );
      expect(result.result).toBe("accepted");
    }
    const overflow = await ingress.ingest(signal("aaaaaaaa-1111-4111-8111-111111111111"));
    expect(overflow).toEqual({ result: "rejected", reason: "normal_capacity" });
    // 紧急保留容量独立：urgent 仍可进入。
    const urgent = await ingress.ingest(signal("bbbbbbbb-1111-4111-8111-111111111111", 900));
    expect(urgent.result).toBe("accepted");
    // 普通队列仍满（未消费）。
    const stillFull = await ingress.ingest(signal("dddddddd-1111-4111-8111-111111111111"));
    expect(stillFull).toEqual({ result: "rejected", reason: "normal_capacity" });
    // 消费水位推进后释放容量；被拒信号不占序号：序号连续。
    store.markConsumed(5n);
    const next = await ingress.ingest(signal("cccccccc-1111-4111-8111-111111111111"));
    expect(next).toMatchObject({ result: "accepted", sequence: 6n });
  });
});

describe("InMemorySignalStore", () => {
  it("markConsumed is monotonic and filters pending", async () => {
    const store = new InMemorySignalStore({
      normalCapacity: 8,
      urgentCapacity: 4,
      dedupeCapacity: 16,
    });
    await store.append(signal("11111111-1111-4111-8111-111111111111"), "normal");
    await store.append(signal("22222222-2222-4222-8222-222222222222"), "normal");
    store.markConsumed(1n);
    expect(store.pendingCounts()).toEqual({ normal: 1, urgent: 0 });
    expect(() => store.markConsumed(0n)).toThrow(/regress/);
    const state = await store.restore();
    expect(state.consumed).toBe(1n);
    expect(state.pending.map((entry) => entry.sequence)).toEqual(["2"]);
  });
});
