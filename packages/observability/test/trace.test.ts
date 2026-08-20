import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { TraceContextSchema } from "@bellis/contracts";
import {
  childTraceContext,
  createTraceContext,
  createTraceContextManager,
  createCryptoTraceRandomSource,
  formatTraceparent,
  parseTraceparent,
} from "../src/index.js";
import type { TraceRandomSource } from "../src/index.js";

const VALID_TRACEPARENT = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";

/** 固定序列的确定性随机源（结构上与 testkit 的 DeterministicIdSource 兼容）。 */
function createSequentialTraceSource(traceSeed: string, spanSeed: string): TraceRandomSource {
  let traceCounter = 0;
  let spanCounter = 0;
  return {
    traceId: () => `${traceSeed}${(traceCounter += 1).toString().padStart(4, "0")}`.slice(0, 32),
    spanId: () => `${spanSeed}${(spanCounter += 1).toString().padStart(4, "0")}`.slice(0, 16),
  };
}

describe("parseTraceparent", () => {
  it("accepts a valid version-00 header", () => {
    expect(parseTraceparent(VALID_TRACEPARENT)).toEqual({
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      traceFlags: 1,
    });
  });

  it("rejects all-zero trace id / span id", () => {
    expect(parseTraceparent(`00-${"0".repeat(32)}-0123456789abcdef-01`)).toBeNull();
    expect(parseTraceparent(`00-0123456789abcdef0123456789abcdef-${"0".repeat(16)}-01`)).toBeNull();
  });

  it("rejects uppercase hex", () => {
    expect(parseTraceparent("00-0123456789ABCDEF0123456789ABCDEF-0123456789ABCDEF-01")).toBeNull();
  });

  it("rejects wrong field widths and versions", () => {
    expect(parseTraceparent("00-0123456789abcdef-0123456789abcdef-01")).toBeNull();
    expect(parseTraceparent(`00-${"1".repeat(31)}-0123456789abcdef-01`)).toBeNull();
    expect(parseTraceparent("00-0123456789abcdef0123456789abcdef-0123456789abcde-01")).toBeNull();
    expect(parseTraceparent("ff-0123456789abcdef0123456789abcdef-0123456789abcdef-01")).toBeNull();
    expect(parseTraceparent("01-0123456789abcdef0123456789abcdef-0123456789abcdef-01")).toBeNull();
  });

  it("rejects malformed flags, extra fields and whitespace", () => {
    expect(parseTraceparent("00-0123456789abcdef0123456789abcdef-0123456789abcdef-0x")).toBeNull();
    expect(parseTraceparent("00-0123456789abcdef0123456789abcdef-0123456789abcdef-1")).toBeNull();
    expect(
      parseTraceparent("00-0123456789abcdef0123456789abcdef-0123456789abcdef-01-extra"),
    ).toBeNull();
    expect(parseTraceparent("00-0123456789abcdef0123456789abcdef-0123456789abcdef")).toBeNull();
    expect(parseTraceparent(` ${VALID_TRACEPARENT}`)).toBeNull();
    expect(parseTraceparent(`${VALID_TRACEPARENT} `)).toBeNull();
    expect(parseTraceparent("")).toBeNull();
  });

  it("accepts arbitrary two-hex flags (byte value preserved)", () => {
    expect(
      parseTraceparent("00-0123456789abcdef0123456789abcdef-0123456789abcdef-ff")?.traceFlags,
    ).toBe(0xff);
    expect(
      parseTraceparent("00-0123456789abcdef0123456789abcdef-0123456789abcdef-00")?.traceFlags,
    ).toBe(0);
  });
});

describe("formatTraceparent", () => {
  it("formats stable lowercase output", () => {
    expect(
      formatTraceparent({
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
        traceFlags: 0,
      }),
    ).toBe("00-0123456789abcdef0123456789abcdef-0123456789abcdef-00");
    expect(
      formatTraceparent({
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
        traceFlags: 0xff,
      }),
    ).toBe("00-0123456789abcdef0123456789abcdef-0123456789abcdef-ff");
  });

  it("throws on invalid inputs", () => {
    const base = { spanId: "0123456789abcdef", traceFlags: 1 };
    expect(() => formatTraceparent({ ...base, traceId: "0".repeat(32) })).toThrow(RangeError);
    expect(() => formatTraceparent({ ...base, traceId: "xyz" })).toThrow(RangeError);
    expect(() =>
      formatTraceparent({
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0".repeat(16),
        traceFlags: 1,
      }),
    ).toThrow(RangeError);
    expect(() =>
      formatTraceparent({
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
        traceFlags: 256,
      }),
    ).toThrow(RangeError);
    expect(() =>
      formatTraceparent({
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
        traceFlags: 1.5,
      }),
    ).toThrow(RangeError);
  });

  it("parse ∘ format is the identity for valid inputs (property)", () => {
    const hexChars = [
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ] as const;
    const tailArb = (length: number) =>
      fc
        .array(fc.constantFrom(...hexChars), { minLength: length, maxLength: length })
        .map((chars) => `1${chars.join("")}`);
    fc.assert(
      fc.property(
        tailArb(31),
        tailArb(15),
        fc.integer({ min: 0, max: 255 }),
        (traceId, spanId, flags) => {
          const formatted = formatTraceparent({ traceId, spanId, traceFlags: flags });
          expect(parseTraceparent(formatted)).toEqual({ traceId, spanId, traceFlags: flags });
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("createTraceContext / childTraceContext", () => {
  it("generates crypto-safe ids that satisfy the contract schema", () => {
    const context = createTraceContext();
    expect(TraceContextSchema.parse(context)).toEqual(context);
    const another = createTraceContext();
    expect(another.traceId).not.toBe(context.traceId);
    expect(another.spanId).not.toBe(context.spanId);
  });

  it("keeps explicitly provided ids and business fields", () => {
    const source = createSequentialTraceSource("00000000000000000000000000ab", "0000000000000ab");
    const context = createTraceContext(
      {
        sessionId: "11111111-1111-4111-8111-111111111111",
        cycleId: "33333333-3333-4333-8333-333333333333",
        extensionNote: "kept",
      },
      source,
    );
    expect(context.traceId).toBe("00000000000000000000000000ab0001");
    expect(context.sessionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(context.cycleId).toBe("33333333-3333-4333-8333-333333333333");
    expect(context.extensionNote).toBe("kept");
  });

  it("uses the injected source only for missing ids", () => {
    const source = createSequentialTraceSource("00000000000000000000000000ab", "0000000000000ab");
    const context = createTraceContext({ traceId: "0123456789abcdef0123456789abcdef" }, source);
    expect(context.traceId).toBe("0123456789abcdef0123456789abcdef");
    expect(context.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("rejects invalid explicit ids instead of silently replacing them", () => {
    expect(() => createTraceContext({ traceId: "not-hex" })).toThrow();
    expect(() => createTraceContext({ sessionId: "not-a-uuid" })).toThrow();
  });

  it("child keeps trace id and business fields, rotates span id", () => {
    const source = createSequentialTraceSource("00000000000000000000000000ab", "0000000000000ab");
    const parent = createTraceContext(
      {
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
        sceneId: "22222222-2222-4222-8222-222222222222",
      },
      source,
    );
    const child = childTraceContext(parent, source);
    expect(child.traceId).toBe(parent.traceId);
    expect(child.spanId).not.toBe(parent.spanId);
    expect(child.sceneId).toBe(parent.sceneId);
    expect(TraceContextSchema.parse(child)).toEqual(child);
  });

  it("crypto source never yields all-zero ids", () => {
    const source = createCryptoTraceRandomSource();
    for (let i = 0; i < 100; i += 1) {
      expect(source.traceId()).toMatch(/^(?!0+$)[0-9a-f]{32}$/);
      expect(source.spanId()).toMatch(/^(?!0+$)[0-9a-f]{16}$/);
    }
  });
});

describe("TraceContextManager", () => {
  it("current() is null without context, never leaks between requests", () => {
    const manager = createTraceContextManager();
    expect(manager.current()).toBeNull();
    let escaped: () => ReturnType<typeof manager.current> = () => manager.current();
    manager.run(createTraceContext(), () => {
      expect(manager.current()).not.toBeNull();
      escaped = () => manager.current();
    });
    // 逃离 run 的闭包在 run 之外执行：不静默复用上一个请求的上下文。
    expect(escaped()).toBeNull();
    expect(manager.current()).toBeNull();
  });

  it("isolates concurrent async tasks", async () => {
    const manager = createTraceContextManager();
    const source = createSequentialTraceSource("00000000000000000000000000ab", "0000000000000ab");
    const first = createTraceContext({}, source);
    const second = createTraceContext({}, source);
    const observed: string[] = [];
    await Promise.all([
      manager.run(first, async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        observed.push(`first:${manager.current()?.traceId === first.traceId}`);
      }),
      manager.run(second, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        observed.push(`second:${manager.current()?.traceId === second.traceId}`);
      }),
    ]);
    // 完成顺序取决于定时器调度；断言关注的是两条异步链各自看到自己的上下文。
    expect([...observed].toSorted()).toEqual(["first:true", "second:true"]);
  });

  it("instances do not share state", () => {
    const managerA = createTraceContextManager();
    const managerB = createTraceContextManager();
    const context = createTraceContext();
    managerA.run(context, () => {
      expect(managerA.current()?.traceId).toBe(context.traceId);
      expect(managerB.current()).toBeNull();
    });
  });

  it("bind wraps callbacks with an explicit context", () => {
    const manager = createTraceContextManager();
    const context = createTraceContext();
    const bound = manager.bind(context, (value: number) => {
      expect(manager.current()?.traceId).toBe(context.traceId);
      return value * 2;
    });
    expect(manager.current()).toBeNull();
    expect(bound(21)).toBe(42);
    expect(manager.current()).toBeNull();
  });
});
