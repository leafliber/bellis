import { describe, expect, it } from "vitest";
import { ClockOffsetEstimator } from "../../src/index.js";

/** c0→r1：客户端 0µs 时 Runtime 已是 1000µs（offset=+1000），上行 100µs。 */
const OFFSET_SAMPLE = {
  c0: 0n,
  r1: 1100n,
  r2: 1150n,
  c3: 250n,
} as const;

describe("ClockOffsetEstimator", () => {
  it("按 NTP 公式计算 RTT 与 Offset（有符号 bigint 域）", () => {
    const estimator = new ClockOffsetEstimator();
    const estimate = estimator.add(OFFSET_SAMPLE);
    // RTT = (250 - 0) - (1150 - 1100) = 200
    // Offset = ((1100 - 0) + (1150 - 250)) / 2 = 1000
    expect(estimate).toEqual({ roundTripUs: 200n, runtimeOffsetUs: 1000n });
  });

  it("支持负 Offset", () => {
    const estimator = new ClockOffsetEstimator();
    const estimate = estimator.add({ c0: 5000n, r1: 1000n, r2: 1100n, c3: 5100n });
    // RTT = 100 - 100 = 0; Offset = ((1000-5000) + (1100-5100)) / 2 = -4000
    expect(estimate).toEqual({ roundTripUs: 0n, runtimeOffsetUs: -4000n });
  });

  it("除法向零截断（±0.5µs 均截断为 0）", () => {
    const positive = new ClockOffsetEstimator();
    // RTT = 1, S = (1-0)+(1-1) = +1 → +0.5 → 0
    const up = positive.add({ c0: 0n, r1: 1n, r2: 1n, c3: 1n });
    expect(up?.runtimeOffsetUs).toBe(0n);
    const negative = new ClockOffsetEstimator();
    // RTT = 1, S = (0-0)+(0-1) = -1 → -0.5 → 0（向零截断；向下取整会是 -1）
    const down = negative.add({ c0: 0n, r1: 0n, r2: 0n, c3: 1n });
    expect(down?.runtimeOffsetUs).toBe(0n);
  });

  it("拒绝 r2 < r1（服务端时钟域倒退）", () => {
    const estimator = new ClockOffsetEstimator();
    const estimate = estimator.add({ c0: 0n, r1: 1000n, r2: 900n, c3: 2000n });
    expect(estimate).toBeNull();
    expect(estimator.sampleCount()).toBe(0);
  });

  it("拒绝 c3 < c0（客户端时钟域倒退）", () => {
    const estimator = new ClockOffsetEstimator();
    expect(estimator.add({ c0: 1000n, r1: 1000n, r2: 1100n, c3: 500n })).toBeNull();
  });

  it("拒绝负 RTT", () => {
    const estimator = new ClockOffsetEstimator();
    // (c3 - c0) = 50 < (r2 - r1) = 100 → RTT = -50
    expect(estimator.add({ c0: 0n, r1: 0n, r2: 100n, c3: 50n })).toBeNull();
  });

  it("拒绝超过配置上限的 RTT 样本", () => {
    const estimator = new ClockOffsetEstimator({ maxSampleRttUs: 100n });
    expect(estimator.add({ c0: 0n, r1: 0n, r2: 0n, c3: 101n })).toBeNull();
    const kept = estimator.add({ c0: 0n, r1: 0n, r2: 0n, c3: 100n });
    expect(kept).not.toBeNull();
  });

  it("样本窗口有界（FIFO 淘汰）", () => {
    const estimator = new ClockOffsetEstimator({ windowSize: 4 });
    for (let index = 0; index < 6; index += 1) {
      estimator.add({ c0: 0n, r1: BigInt(index), r2: BigInt(index), c3: 10n });
    }
    expect(estimator.sampleCount()).toBe(4);
  });

  it("高 RTT 样本不能覆盖明显更优样本（最小 RTT 集合的中位 Offset）", () => {
    const estimator = new ClockOffsetEstimator({ windowSize: 8, maxSampleRttUs: 1_000_000n });
    // 4 个低 RTT 样本（RTT=100，Offset=-300/-100/+100/+300）+ 4 个高 RTT
    // 样本（RTT=900，Offset=+100000）。bestFraction=0.5 → 最优半区恰为
    // 4 个低 RTT 样本；其 Offset 下中位数 = -100。
    const goodOffsets = [-300n, -100n, 100n, 300n];
    for (const offset of goodOffsets) {
      // c0=0, r1=offset+50, r2=offset+50, c3=100 → RTT=100, Offset=offset
      estimator.add({ c0: 0n, r1: offset + 50n, r2: offset + 50n, c3: 100n });
    }
    for (let index = 0; index < 4; index += 1) {
      estimator.add({ c0: 0n, r1: 100_050n, r2: 100_050n, c3: 1000n });
    }
    const after = estimator.current();
    expect(after?.roundTripUs).toBe(100n);
    expect(after?.runtimeOffsetUs).toBe(-100n);
  });

  it("最优半区的确定性选择（等 RTT 时取稳定前半）", () => {
    const estimator = new ClockOffsetEstimator({ windowSize: 4, bestFraction: 0.5 });
    // 4 个等 RTT 样本：bestCount = ceil(4×0.5) = 2 → 取排序稳定的前两个。
    for (const offset of [-300n, -100n, 100n, 300n]) {
      estimator.add({ c0: 0n, r1: offset + 50n, r2: offset + 50n, c3: 100n });
    }
    const estimate = estimator.current();
    expect(estimate?.roundTripUs).toBe(100n);
    expect(estimate?.runtimeOffsetUs).toBe(-300n);
  });

  it("reset() 清空估计（重连重新校准）", () => {
    const estimator = new ClockOffsetEstimator();
    estimator.add(OFFSET_SAMPLE);
    expect(estimator.current()).not.toBeNull();
    estimator.reset();
    expect(estimator.current()).toBeNull();
    expect(estimator.sampleCount()).toBe(0);
  });

  it("非法参数在构造时抛出", () => {
    expect(() => new ClockOffsetEstimator({ windowSize: 0 })).toThrow(RangeError);
    expect(() => new ClockOffsetEstimator({ bestFraction: 0 })).toThrow(RangeError);
    expect(() => new ClockOffsetEstimator({ maxSampleRttUs: -1n })).toThrow(RangeError);
  });
});
