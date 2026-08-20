import { describe, expect, it } from "vitest";
import { SpanIdSchema, TraceIdSchema, UuidSchema } from "@bellis/contracts";
import { createDeterministicIdSource, createDeterministicRandom } from "../src/index.js";

describe("createDeterministicIdSource", () => {
  it("replays identical sequences for identical seeds and call order", () => {
    const first = createDeterministicIdSource("seed-alpha");
    const second = createDeterministicIdSource("seed-alpha");
    for (let i = 0; i < 25; i += 1) {
      expect(first.uuid()).toBe(second.uuid());
      expect(first.traceId()).toBe(second.traceId());
      expect(first.spanId()).toBe(second.spanId());
    }
  });

  it("produces different sequences for different seeds", () => {
    const first = createDeterministicIdSource("seed-alpha");
    const second = createDeterministicIdSource("seed-beta");
    expect(first.uuid()).not.toBe(second.uuid());
    expect(first.traceId()).not.toBe(second.traceId());
  });

  it("isolates namespaces while staying deterministic per namespace", () => {
    const source = createDeterministicIdSource("seed-alpha");
    const replay = createDeterministicIdSource("seed-alpha");
    const firstFromA = source.uuid("session");
    const firstFromB = source.uuid("scene");
    expect(firstFromA).not.toBe(firstFromB);
    // 各命名空间独立推进：先调用别的命名空间不影响本命名空间的序列。
    expect(replay.uuid("session")).toBe(firstFromA);
    expect(replay.uuid("scene")).toBe(firstFromB);
    expect(source.uuid("session")).not.toBe(firstFromA);
    // 默认命名空间与显式命名空间互不串扰。
    const defaultFirst = source.uuid();
    expect(defaultFirst).not.toBe(firstFromA);
  });

  it("emits ids that satisfy the contracts schemas", () => {
    const source = createDeterministicIdSource("schema-check");
    for (let i = 0; i < 50; i += 1) {
      expect(UuidSchema.safeParse(source.uuid("message")).success).toBe(true);
      expect(TraceIdSchema.safeParse(source.traceId()).success).toBe(true);
      expect(SpanIdSchema.safeParse(source.spanId()).success).toBe(true);
      // v4 形态：版本位 4、变体位 8/9/a/b，带连字符的规范形式。
      expect(source.uuid("record")).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(source.traceId()).toMatch(/^(?!0+$)[0-9a-f]{32}$/);
      expect(source.spanId()).toMatch(/^(?!0+$)[0-9a-f]{16}$/);
    }
  });

  it("rejects empty seeds", () => {
    expect(() => createDeterministicIdSource("")).toThrow(RangeError);
  });
});

describe("createDeterministicRandom", () => {
  it("replays the same sequence for the same seed", () => {
    const first = createDeterministicRandom("jitter");
    const second = createDeterministicRandom("jitter");
    for (let i = 0; i < 50; i += 1) {
      expect(first.next()).toBe(second.next());
    }
    const other = createDeterministicRandom("other");
    expect(other.next()).not.toBe(first.next());
  });

  it("keeps next() within [0, 1) and int() within its bound", () => {
    const random = createDeterministicRandom("bounds");
    for (let i = 0; i < 500; i += 1) {
      const value = random.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      const pick = random.int(7);
      expect(pick).toBeGreaterThanOrEqual(0);
      expect(pick).toBeLessThan(7);
      expect(Number.isInteger(pick)).toBe(true);
    }
  });

  it("supports bool and pick deterministically", () => {
    const random = createDeterministicRandom("helpers");
    const replay = createDeterministicRandom("helpers");
    const items = ["a", "b", "c", "d"] as const;
    for (let i = 0; i < 20; i += 1) {
      expect(random.bool()).toBe(replay.bool());
      expect(random.pick(items)).toBe(replay.pick(items));
    }
    expect(() => random.pick([])).toThrow(RangeError);
    expect(() => random.int(0)).toThrow(RangeError);
    expect(() => random.int(1.5)).toThrow(RangeError);
  });
});
