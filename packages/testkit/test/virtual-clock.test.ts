import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { VirtualClock } from "../src/virtual-clock.js";

/**
 * Gate 1 VirtualClock 契约测试（phase-1-build-guide.md §7.1、§11）：
 * - 目标已过立即完成。
 * - Abort 以取消原因拒绝，等待者被移出队列。
 * - 多个等待者按目标时间升序释放；相同目标按注册顺序。
 * - 大步推进一次释放所有到期任务。
 * - 时钟永不倒退；任何推进方式都不让任务在目标时间前完成。
 * - 全程不依赖真实定时器。
 */

describe("VirtualClock 基础行为", () => {
  it("starts at zero and never goes backwards", () => {
    const clock = new VirtualClock();
    expect(clock.nowUs()).toBe(0n);
    clock.advance(100n);
    clock.advance(200n);
    expect(clock.nowUs()).toBe(200n);
    expect(() => clock.advance(199n)).toThrow(RangeError);
  });

  it("sleepUntil resolves immediately when target already passed", async () => {
    const clock = new VirtualClock();
    clock.advance(500n);
    await clock.sleepUntil(100n);
    await clock.sleepUntil(500n);
    expect(clock.pendingCount()).toBe(0);
  });

  it("advances by delta", () => {
    const clock = new VirtualClock();
    clock.advanceBy(250n);
    clock.advanceBy(250n);
    expect(clock.nowUs()).toBe(500n);
  });
});

describe("VirtualClock 等待者释放", () => {
  it("releases waiters in ascending target order regardless of registration order", async () => {
    const clock = new VirtualClock();
    const released: number[] = [];
    void clock.sleepUntil(300n).then(() => released.push(300));
    void clock.sleepUntil(100n).then(() => released.push(100));
    void clock.sleepUntil(200n).then(() => released.push(200));
    expect(clock.pendingCount()).toBe(3);
    clock.advance(400n);
    await Promise.resolve();
    expect(released).toEqual([100, 200, 300]);
    expect(clock.pendingCount()).toBe(0);
  });

  it("keeps FIFO order for equal targets", async () => {
    const clock = new VirtualClock();
    const released: string[] = [];
    void clock.sleepUntil(100n).then(() => released.push("a"));
    void clock.sleepUntil(100n).then(() => released.push("b"));
    void clock.sleepUntil(100n).then(() => released.push("c"));
    clock.advance(100n);
    await Promise.resolve();
    expect(released).toEqual(["a", "b", "c"]);
  });

  it("one big step releases all due tasks at once", async () => {
    const clock = new VirtualClock();
    let resolved = 0;
    const pending: Promise<void>[] = [];
    for (const target of [10n, 20n, 50n, 90n]) {
      pending.push(
        clock.sleepUntil(target).then(() => {
          resolved += 1;
        }),
      );
    }
    clock.advance(100n);
    await Promise.all(pending);
    expect(resolved).toBe(4);
  });

  it("future waiters stay pending after a partial advance", async () => {
    const clock = new VirtualClock();
    let early = false;
    let late = false;
    void clock.sleepUntil(50n).then(() => {
      early = true;
    });
    void clock.sleepUntil(150n).then(() => {
      late = true;
    });
    clock.advance(100n);
    await Promise.resolve();
    expect(early).toBe(true);
    expect(late).toBe(false);
    expect(clock.pendingCount()).toBe(1);
    clock.advance(200n);
    await Promise.resolve();
    expect(late).toBe(true);
  });
});

describe("VirtualClock 取消", () => {
  it("rejects with the abort reason and removes the waiter", async () => {
    const clock = new VirtualClock();
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const pending = clock.sleepUntil(100n, controller.signal);
    expect(clock.pendingCount()).toBe(1);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(clock.pendingCount()).toBe(0);
    clock.advance(200n);
  });

  it("rejects immediately when signal is already aborted", async () => {
    const clock = new VirtualClock();
    const controller = new AbortController();
    controller.abort();
    await expect(clock.sleepUntil(0n, controller.signal)).rejects.toThrow();
    expect(clock.pendingCount()).toBe(0);
  });

  it("resolves normally if released before abort", async () => {
    const clock = new VirtualClock();
    const controller = new AbortController();
    const pending = clock.sleepUntil(100n, controller.signal);
    clock.advance(100n);
    await expect(pending).resolves.toBeUndefined();
    controller.abort(new Error("later abort must not affect resolved sleep"));
  });
});

describe("VirtualClock 性质", () => {
  const targetArb = fc.bigInt({ min: 0n, max: 10_000n });

  it("never completes a sleep before its target time", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(targetArb, { minLength: 0, maxLength: 20 }),
        fc.array(targetArb, { minLength: 0, maxLength: 20 }),
        async (targets, steps) => {
          const clock = new VirtualClock();
          const completions: { target: bigint; atUs: bigint }[] = [];
          const pending = targets.map((target) =>
            clock.sleepUntil(target).then(() => {
              completions.push({ target, atUs: clock.nowUs() });
            }),
          );
          for (const step of steps) {
            clock.advance(clock.nowUs() + step);
          }
          // 最后一步确保覆盖全部目标（target ≤ 10_000），让所有等待者落地。
          clock.advance(clock.nowUs() + 10_001n);
          await Promise.all(pending);
          return completions.every((completion) => completion.atUs >= completion.target);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("releases due waiters in ascending target order within one advance", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(targetArb, { minLength: 1, maxLength: 20 }), async (targets) => {
        const clock = new VirtualClock();
        const order: bigint[] = [];
        const pending = targets.map((target) =>
          clock.sleepUntil(target).then(() => {
            order.push(target);
          }),
        );
        clock.advance(20_000n);
        await Promise.all(pending);
        const due = [...targets].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        return order.every((value, index) => value === due[index]);
      }),
      { numRuns: 100 },
    );
  });
});
