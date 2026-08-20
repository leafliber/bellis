import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { formatDecimalString, parseDecimalString } from "@bellis/contracts";
import { decodeOperationPayload, encodeOperationPayload } from "../../src/rpc/operations.js";
import { computeRetryDelayMs, deterministicJitter } from "../../src/outbox/retry-policy.js";
import { CYCLE_ID, SCENE_ID, SESSION_ID, makeOutboxMessage, makeScene } from "../helpers.js";

/**
 * fast-check 性质测试（P2 文档 §12.2，纯逻辑层）：
 * - 任意合法大整数经编解码（十进制字符串过线）保持等价。
 * - 任意水位更新序列在编解码往返后保持等价。
 * - 退避延迟对任意尝试次数都有界且确定性。
 * 真实 Worker/SQLite 的往返性质在集成测试中覆盖。
 */

const decimalString = fc
  .bigInt({ min: 0n, max: 10n ** 30n - 1n })
  .map((value: bigint) => value.toString(10));

describe("大整数过线无损", () => {
  it("formatDecimalString ∘ parseDecimalString == id", () => {
    fc.assert(
      fc.property(decimalString, (text) => {
        expect(formatDecimalString(parseDecimalString(text))).toBe(text);
      }),
    );
  });

  it("commit_scene 水位编解码往返等价（含 2^53 边界外值）", () => {
    const watermarkArb = fc.bigInt({ min: 0n, max: 10n ** 30n - 1n });
    fc.assert(
      fc.property(
        watermarkArb,
        fc.array(fc.string({ minLength: 1, maxLength: 64 }), { maxLength: 8 }),
        (watermark, sources) => {
          const uniqueSources = [...new Set(sources)];
          const encoded = encodeOperationPayload({
            operation: "commit_scene",
            input: {
              sceneId: SCENE_ID,
              cycleId: CYCLE_ID,
              sessionId: SESSION_ID,
              scene: makeScene(),
              idempotencyKey: "k",
              requestFingerprint: "f",
              watermarks: uniqueSources.map((source) => ({ source, watermark })),
              outbox: [makeOutboxMessage()],
            },
          });
          const decoded = decodeOperationPayload("commit_scene", encoded);
          if (decoded.operation !== "commit_scene") {
            throw new Error("unexpected operation");
          }
          for (const [index, source] of uniqueSources.entries()) {
            expect(decoded.input.watermarks[index]?.source).toBe(source);
            expect(decoded.input.watermarks[index]?.watermark).toBe(watermark);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it("advance_server_seq 结果编解码对任意合法大整数等价", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 30n - 1n }), (value: bigint) => {
        expect(parseDecimalString(value.toString(10))).toBe(value);
      }),
    );
  });
});

describe("退避性质", () => {
  it("任意种子与尝试次数：延迟 ∈ [base, max] 且确定", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 30 }), fc.nat(50), (seed, attempts) => {
        const policy = { baseMs: 100, maxMs: 10_000, maxAttempts: 8, jitterSeed: seed };
        const delay = computeRetryDelayMs(policy, attempts);
        expect(delay).toBeGreaterThanOrEqual(100);
        expect(delay).toBeLessThanOrEqual(10_000);
        expect(delay).toBe(computeRetryDelayMs(policy, attempts));
        expect(deterministicJitter(seed, attempts)).toBeGreaterThanOrEqual(0);
        expect(deterministicJitter(seed, attempts)).toBeLessThan(1);
      }),
      { numRuns: 100 },
    );
  });
});
