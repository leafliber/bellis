import { describe, expect, it } from "vitest";
import { SystemMonotonicClock } from "../../src/index.js";

/**
 * SystemMonotonicClock 使用真实 hrtime；测试只用毫秒级短等待验证语义，
 * 业务时长调度一律由 VirtualClock（testkit）承担。
 */

describe("SystemMonotonicClock", () => {
  it("nowUs 单调不减且为正数", () => {
    const clock = new SystemMonotonicClock();
    const first = clock.nowUs();
    const second = clock.nowUs();
    expect(first > 0n).toBe(true);
    expect(second >= first).toBe(true);
  });

  it("目标已过时立即完成", async () => {
    const clock = new SystemMonotonicClock();
    const now = clock.nowUs();
    await clock.sleepUntil(now - 1n);
  });

  it("等待在目标时间之后（不早于目标）完成", async () => {
    const clock = new SystemMonotonicClock();
    const target = clock.nowUs() + 5_000n; // 5ms
    await clock.sleepUntil(target);
    expect(clock.nowUs() >= target).toBe(true);
  });

  it("调用前已 Abort：以取消原因拒绝", async () => {
    const clock = new SystemMonotonicClock();
    const controller = new AbortController();
    const reason = new Error("pre-aborted");
    controller.abort(reason);
    await expect(clock.sleepUntil(clock.nowUs() + 60_000n, controller.signal)).rejects.toBe(reason);
  });

  it("等待中 Abort：以取消原因拒绝且不完成", async () => {
    const clock = new SystemMonotonicClock();
    const controller = new AbortController();
    const reason = new Error("mid-aborted");
    const pending = clock.sleepUntil(clock.nowUs() + 60_000n, controller.signal);
    const expectation = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await expectation;
  });

  it("多个并发等待按目标顺序释放", async () => {
    const clock = new SystemMonotonicClock();
    const base = clock.nowUs();
    const order: number[] = [];
    const waits = [4_000n, 2_000n, 6_000n].map(async (delay, index) => {
      await clock.sleepUntil(base + delay);
      order.push(index);
    });
    await Promise.all(waits);
    expect(order).toEqual([1, 0, 2]);
  });

  it("close() 拒绝全部挂起等待，之后的 sleepUntil 立即拒绝", async () => {
    const clock = new SystemMonotonicClock();
    const base = clock.nowUs();
    const pending = clock.sleepUntil(base + 60_000n);
    const expectation = expect(pending).rejects.toThrow(/system_monotonic_clock_closed/);
    clock.close();
    await expectation;
    await expect(clock.sleepUntil(base + 60_000n)).rejects.toThrow(/system_monotonic_clock_closed/);
  });

  it("已完成的等待在 Abort 后不受影响", async () => {
    const clock = new SystemMonotonicClock();
    const controller = new AbortController();
    await clock.sleepUntil(clock.nowUs() + 2_000n, controller.signal);
    controller.abort(new Error("late"));
    // 不抛错即通过：resolve 之后的 abort 不会把已完成 Promise 变成拒绝。
  });
});
