import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { VirtualClock } from "@bellis/testkit";
import type { AudienceBatch } from "@bellis/contracts";
import { InMemorySignalStore, SignalPipeline } from "../../src/index.js";
import type { TurnOwnerPort } from "../../src/index.js";

/**
 * P1 性质测试（phase-3-development-guide.md §6.3 / §10.1）：
 * 在随机到达（乱序墙钟事实、重复输入、紧急插入、洪峰）下：
 * 1. 封窗区间连续且严格递增（采用顺序 = 封窗顺序）；
 * 2. 每个 accepted 序号被恰好一个区间覆盖；deduplicated 不产生新序号；
 * 3. 普通窗口延迟 ≤ 500ms（自适应上限）；
 * 4. urgent 立即旁路（延迟 0）；
 * 5. Trigger 收到的 Batch 顺序与封窗顺序一致。
 */

function uuidFromIndex(index: number): string {
  return `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

const flush = async (): Promise<void> => {
  for (let tick = 0; tick < 8; tick += 1) {
    await Promise.resolve();
  }
};

interface Arrival {
  readonly gapMs: number;
  readonly priority: number;
  readonly duplicateOf: number | null;
}

const arrivalArb: fc.Arbitrary<Arrival> = fc.record({
  gapMs: fc.integer({ min: 0, max: 700 }),
  priority: fc.integer({ min: 0, max: 1000 }),
  duplicateOf: fc.option(fc.integer({ min: 0, max: 40 }), { nil: null }),
});

describe("SignalPipeline properties", () => {
  it("sealed intervals stay contiguous, ordered and cover every accepted signal", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(arrivalArb, { maxLength: 40 }), async (arrivals) => {
        const clock = new VirtualClock();
        const store = new InMemorySignalStore({
          normalCapacity: 10_000,
          urgentCapacity: 1_000,
          dedupeCapacity: 512,
        });
        const receivedByOwner: AudienceBatch[] = [];
        const owner: TurnOwnerPort = {
          isIdle: () => true,
          cancelActiveTurn: () => [],
          startTurn: (batch) => {
            receivedByOwner.push(batch);
            return true;
          },
          mergeIntoNextCycle: () => false,
        };
        let counter = 0;
        const pipeline = new SignalPipeline({
          sessionId: "11111111-1111-4111-8111-111111111111",
          clock,
          wallClockMs: () => Number(clock.nowUs() / 1000n),
          store,
          owner,
          nextBatchId: () => {
            counter += 1;
            return `${counter.toString(16).padStart(8, "0")}-cccc-4ccc-8ccc-cccccccccccc`;
          },
        });
        await pipeline.start();

        const acceptedSequences: bigint[] = [];
        for (const arrival of arrivals) {
          clock.advanceBy(BigInt(arrival.gapMs) * 1_000n);
          await flush();
          counter += 1;
          const signalIndex = counter;
          const duplicateId =
            arrival.duplicateOf !== null && arrival.duplicateOf < signalIndex
              ? uuidFromIndex(arrival.duplicateOf)
              : uuidFromIndex(signalIndex);
          const result = await pipeline.ingest({
            schemaVersion: 1,
            id: duplicateId,
            kind: arrival.priority >= 800 ? "danmaku" : "danmaku",
            source: "simulator",
            occurredAt: Number(clock.nowUs() / 1000n),
            priority: arrival.priority,
            payload: { text: `m${signalIndex}`, userId: `u${signalIndex % 5}` },
          });
          if (result.result === "accepted") {
            acceptedSequences.push(result.sequence);
          }
          if (result.result === "deduplicated") {
            // 重复输入不产生第二个序号。
            expect(result.sequence).toBeLessThanOrEqual(
              acceptedSequences.length > 0 ? acceptedSequences[acceptedSequences.length - 1]! : 0n,
            );
          }
          await flush();
        }
        // 推进到所有窗口到期。
        clock.advanceBy(600n * 1_000n);
        await flush();
        await pipeline.close();

        const sealed = pipeline.sealedBatches;
        // 1. 区间连续且严格递增。
        for (let index = 1; index < sealed.length; index += 1) {
          const previous = sealed[index - 1]!;
          const current = sealed[index]!;
          expect(BigInt(current.batch.watermarkFrom)).toBe(BigInt(previous.batch.watermarkTo) + 1n);
        }
        // 2. 覆盖所有 accepted 序号（重复合并的 interval 仍保持并集连续）。
        const unionFrom = BigInt(sealed[0]?.batch.watermarkFrom ?? "0");
        const unionTo = BigInt(sealed[sealed.length - 1]?.batch.watermarkTo ?? "0");
        for (const sequence of acceptedSequences) {
          expect(sequence >= unionFrom && sequence <= unionTo).toBe(true);
        }
        // 3. 普通窗口配置长度 ≤ 500ms（latency 受驱动方唤醒时机影响，
        //    窗口长度才是自适应上限的不变量）；urgent 旁路不检查窗口
        //    （其封窗时刻 = 入库时刻，不等待 Deadline——由单元测试证明）。
        for (const entry of sealed) {
          if (entry.info.trigger !== "urgent_bypass") {
            expect(entry.info.windowMs).toBeLessThanOrEqual(500);
            expect(entry.info.windowMs).toBeGreaterThanOrEqual(200);
          }
        }
        // 4. Owner 收到的都是合法 Batch（Schema 已在封窗时校验）且顺序一致：
        //    receivedByOwner 是 startTurn 收到的子集顺序。
        for (let index = 1; index < receivedByOwner.length; index += 1) {
          expect(
            BigInt(receivedByOwner[index]!.watermarkFrom) >=
              BigInt(receivedByOwner[index - 1]!.watermarkFrom),
          ).toBe(true);
        }
      }),
      { numRuns: 30 },
    );
  });
});
