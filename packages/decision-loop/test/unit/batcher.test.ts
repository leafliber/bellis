import { describe, expect, it } from "vitest";
import { VirtualClock } from "@bellis/testkit";
import { AudienceBatcher } from "../../src/index.js";
import type { BatchSealInfo, BatcherConfig } from "../../src/index.js";
import type { AudienceBatch, IngestedSignal, Signal } from "@bellis/contracts";

let batchCounter = 0;

function nextBatchId(): string {
  batchCounter += 1;
  return `${batchCounter.toString(16).padStart(8, "0")}-cccc-4ccc-8ccc-cccccccccccc`;
}

function makeBatcher(clock: VirtualClock, config?: Partial<BatcherConfig>) {
  const sealed: { batch: AudienceBatch; info: BatchSealInfo }[] = [];
  const batcher = new AudienceBatcher({
    clock,
    ...(config === undefined ? {} : { config }),
    nextBatchId,
    onBatch: (batch, info) => {
      sealed.push({ batch, info });
    },
  });
  return { batcher, sealed };
}

function ingested(
  id: string,
  text: string,
  sequence: number,
  priorityClass: "normal" | "urgent" = "normal",
  priority = 100,
): IngestedSignal {
  const signal: Signal = {
    schemaVersion: 1,
    id,
    kind: priorityClass === "urgent" ? "moderator_command" : "danmaku",
    source: "simulator",
    occurredAt: 0,
    priority,
    payload: { text, userId: `u${sequence}` },
  };
  return {
    schemaVersion: 1,
    signalId: id,
    sequence: sequence.toString(10),
    priorityClass,
    receivedAtMs: 0,
    signal,
  };
}

function hexId(prefix: string, index: number): string {
  return `${(prefix + index.toString(16)).slice(0, 8).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

const MS = 1_000n;

describe("AudienceBatcher", () => {
  it("seals on deadline with the adaptive window (200ms baseline)", () => {
    const clock = new VirtualClock();
    const { batcher, sealed } = makeBatcher(clock);
    batcher.onIngested(ingested(hexId("a", 1), "冲", 1));
    expect(batcher.currentDeadlineUs).toBe(200n * MS);
    clock.advanceBy(200n * MS);
    batcher.onDeadline(clock.nowUs());
    expect(sealed.length).toBe(1);
    expect(sealed[0]?.info.trigger).toBe("deadline");
    expect(sealed[0]?.batch.watermarkFrom).toBe("1");
    expect(sealed[0]?.batch.watermarkTo).toBe("1");
    expect(sealed[0]?.info.latencyMs).toBe(200);
  });

  it("extends the window for backlog (350ms / 500ms), staying within 200–500ms", () => {
    const clock = new VirtualClock();
    const { batcher } = makeBatcher(clock);
    batcher.restore(
      Array.from({ length: 8 }, (_, index) => ingested(hexId("b", index), `m${index}`, index + 1)),
      0n,
    );
    expect(batcher.currentDeadlineUs).toBe(350n * MS);
    batcher.cancelWindow();

    const clock2 = new VirtualClock();
    const { batcher: batcher2 } = makeBatcher(clock2);
    batcher2.restore(
      Array.from({ length: 32 }, (_, index) => ingested(hexId("c", index), `m${index}`, index + 1)),
      0n,
    );
    expect(batcher2.currentDeadlineUs).toBe(500n * MS);
  });

  it("seals immediately on urgent signal without waiting for the window", () => {
    const clock = new VirtualClock();
    const { batcher, sealed } = makeBatcher(clock);
    batcher.onIngested(ingested(hexId("d", 1), "普通", 1));
    batcher.onIngested(ingested(hexId("d", 2), "紧急", 2, "urgent", 900));
    expect(sealed.length).toBe(1);
    const { batch, info } = sealed[0]!;
    expect(info.trigger).toBe("urgent_bypass");
    expect(batch.watermarkFrom).toBe("1");
    expect(batch.watermarkTo).toBe("2");
    expect(batch.urgentSignals.length).toBe(1);
    expect(batch.highlights.length).toBe(1);
    expect(info.latencyMs).toBe(0);
    // 旁路封窗后缓冲清空、窗口关闭。
    expect(batcher.pendingCount).toBe(0);
    expect(batcher.currentDeadlineUs).toBeNull();
  });

  it("seals on message count cap and reopens a fresh window for later signals", () => {
    const clock = new VirtualClock();
    const { batcher, sealed } = makeBatcher(clock);
    for (let index = 0; index < 64; index += 1) {
      batcher.onIngested(ingested(hexId("e", index), `m${index}`, index + 1));
    }
    expect(sealed.length).toBe(1);
    expect(sealed[0]?.info.trigger).toBe("count");
    expect(sealed[0]?.batch.watermarkTo).toBe("64");
    expect(batcher.currentDeadlineUs).toBeNull();
    // 封窗后到达的新信号打开新窗口。
    batcher.onIngested(ingested(hexId("e", 64), `m64`, 65));
    expect(batcher.currentDeadlineUs).not.toBeNull();
    expect(batcher.pendingCount).toBe(1);
  });

  it("seals on token budget cap", () => {
    const clock = new VirtualClock();
    const { batcher, sealed } = makeBatcher(clock);
    // 每条 200 token（400 字符 ASCII）且 400 字节：token 4000 在第 20 条触发，
    // 字节 16384 未达。
    const long = "a".repeat(400);
    for (let index = 0; index < 20; index += 1) {
      batcher.onIngested(ingested(hexId("f", index), long, index + 1));
      if (sealed.length > 0) {
        break;
      }
    }
    expect(sealed.length).toBe(1);
    expect(sealed[0]?.info.trigger).toBe("token_budget");
  });

  it("seals on byte budget cap", () => {
    const clock = new VirtualClock();
    const { batcher, sealed } = makeBatcher(clock);
    // 每条 1 KiB：16 条达到 16 KiB 上限。
    const kilo = "字".repeat(512);
    for (let index = 0; index < 16; index += 1) {
      batcher.onIngested(ingested(hexId("9", index), kilo, index + 1));
      if (sealed.length > 0) {
        break;
      }
    }
    expect(sealed.length).toBe(1);
    expect(sealed[0]?.info.trigger).toBe("byte_budget");
  });

  it("keeps sealed intervals contiguous and non-overlapping", () => {
    const clock = new VirtualClock();
    const { batcher, sealed } = makeBatcher(clock);
    batcher.onIngested(ingested(hexId("8", 1), "a", 1));
    clock.advanceBy(200n * MS);
    batcher.onDeadline(clock.nowUs());
    batcher.onIngested(ingested(hexId("8", 2), "b", 2));
    clock.advanceBy(200n * MS);
    batcher.onDeadline(clock.nowUs());
    batcher.onIngested(ingested(hexId("8", 3), "c", 3, "urgent", 900));
    const intervals = sealed.map(({ batch }) => [
      BigInt(batch.watermarkFrom),
      BigInt(batch.watermarkTo),
    ]);
    expect(intervals).toEqual([
      [1n, 1n],
      [2n, 2n],
      [3n, 3n],
    ]);
  });

  it("restore: normals enter a fresh window from the consumed watermark", () => {
    const clock = new VirtualClock();
    const { batcher, sealed } = makeBatcher(clock);
    batcher.restore([ingested(hexId("7", 1), "n1", 1), ingested(hexId("7", 2), "n2", 2)], 0n);
    expect(sealed.length).toBe(0);
    expect(batcher.pendingCount).toBe(2);
    expect(batcher.currentDeadlineUs).toBe(clock.nowUs() + 200n * MS);
    clock.advanceBy(200n * MS);
    batcher.onDeadline(clock.nowUs());
    expect(sealed[0]?.batch.watermarkFrom).toBe("1");
    expect(sealed[0]?.batch.watermarkTo).toBe("2");
  });

  it("restore: pending urgent below consumed watermark stays inert", () => {
    const clock = new VirtualClock();
    const { batcher, sealed } = makeBatcher(clock);
    // 恢复水位 3：序号 1-3 已消费，窗口不应包含它们。
    batcher.restore(
      [ingested(hexId("6", 1), "old", 1), ingested(hexId("6", 4), "new", 4, "urgent", 900)],
      3n,
    );
    expect(sealed.length).toBe(1);
    expect(sealed[0]?.batch.watermarkFrom).toBe("4");
    expect(sealed[0]?.batch.watermarkTo).toBe("4");
  });
});
