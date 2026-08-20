import { describe, expect, it } from "vitest";
import {
  DEFAULT_OUTBOX_RETRY_POLICY,
  computeRetryDelayMs,
  deterministicJitter,
  shouldDeadLetter,
} from "../../src/outbox/retry-policy.js";

describe("Outbox 重试策略", () => {
  it("抖动确定性：相同种子与尝试次数得到相同值", () => {
    for (let attempts = 0; attempts < 20; attempts += 1) {
      expect(deterministicJitter(1234, attempts)).toBe(deterministicJitter(1234, attempts));
      expect(deterministicJitter(1234, attempts)).not.toBe(deterministicJitter(1235, attempts));
    }
  });

  it("抖动范围 [0, 1)", () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const value = deterministicJitter(seed, seed % 10);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("延迟不超过 maxMs", () => {
    const policy = { ...DEFAULT_OUTBOX_RETRY_POLICY, baseMs: 1000, maxMs: 5000 };
    for (let attempts = 0; attempts < 40; attempts += 1) {
      expect(computeRetryDelayMs(policy, attempts)).toBeLessThanOrEqual(5000);
    }
  });

  it("延迟随尝试次数指数增长（受抖动 ≤25% 与上限约束）", () => {
    const policy = { ...DEFAULT_OUTBOX_RETRY_POLICY, jitterSeed: 0, maxMs: 1e9 };
    const d0 = computeRetryDelayMs(policy, 0);
    const d3 = computeRetryDelayMs(policy, 3);
    const d6 = computeRetryDelayMs(policy, 6);
    expect(d0).toBeGreaterThanOrEqual(policy.baseMs);
    expect(d3).toBeGreaterThan(d0 * 4);
    expect(d6).toBeGreaterThan(d3 * 4);
  });

  it("不可重试或超过 maxAttempts 进入 Dead Letter", () => {
    const policy = { ...DEFAULT_OUTBOX_RETRY_POLICY, maxAttempts: 3 };
    expect(shouldDeadLetter(policy, 0, false)).toBe(true);
    expect(shouldDeadLetter(policy, 2, true)).toBe(false);
    expect(shouldDeadLetter(policy, 3, true)).toBe(true);
  });
});
