import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  SENSITIVE_LOG_FIELD_NAMES,
  canonicalFieldName,
  isSensitiveFieldName,
  redactValue,
  serializeErrorForLog,
} from "../src/index.js";

/**
 * Redaction 评审基线（p3-observability-testkit.md §7.2、§11.2）：
 * 敏感原值不得出现在序列化输出的任何位置，而不只是顶层字段。
 */

function createThrowingGetterObject(): object {
  return {
    safe: 1,
    get boom(): number {
      throw new Error("getter exploded");
    },
  };
}

describe("field name matching", () => {
  it("covers the full sensitive list case-insensitively", () => {
    for (const name of SENSITIVE_LOG_FIELD_NAMES) {
      expect(isSensitiveFieldName(name)).toBe(true);
      expect(isSensitiveFieldName(name.toUpperCase())).toBe(true);
      expect(isSensitiveFieldName(name.toLowerCase())).toBe(true);
    }
  });

  it("matches separator variants but not unrelated names", () => {
    expect(isSensitiveFieldName("api_key")).toBe(true);
    expect(isSensitiveFieldName("API-KEY")).toBe(true);
    expect(isSensitiveFieldName("Set_Cookie")).toBe(true);
    expect(isSensitiveFieldName("sessionToken")).toBe(true);
    expect(isSensitiveFieldName("username")).toBe(false);
    expect(isSensitiveFieldName("tokenCount")).toBe(false);
  });

  it("canonicalizes deterministically (property)", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 32 }), (key) => {
        expect(canonicalFieldName(key)).toBe(key.toLowerCase().replace(/[^a-z0-9]/g, ""));
      }),
      { numRuns: 100 },
    );
  });
});

describe("redactValue", () => {
  it("redacts sensitive fields at any depth, in objects and arrays", () => {
    const secret = "s3cr3t-value";
    const input = {
      authorization: `Bearer ${secret}`,
      headers: {
        Cookie: `session=${secret}`,
        "X-Trace": "keep-me",
        list: [{ apiKey: secret }, { ok: true }],
      },
    };
    const output = JSON.stringify(redactValue(input));
    expect(output).not.toContain(secret);
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed.authorization).toBe("[redacted]");
    const headers = parsed.headers as Record<string, unknown>;
    expect(headers["X-Trace"]).toBe("keep-me");
    const list = headers.list as Array<Record<string, unknown>>;
    expect(list[0]?.apiKey).toBe("[redacted]");
    expect(list[1]?.ok).toBe(true);
  });

  it("keeps non-sensitive payloads intact", () => {
    const input = { sceneId: "22222222-2222-4222-8222-222222222222", nested: { seq: "42" } };
    expect(JSON.parse(JSON.stringify(redactValue(input)))).toEqual(input);
  });

  it("does not modify the caller's object", () => {
    const input = { token: "keep-original", nested: { password: "keep" } };
    const snapshot = JSON.stringify(input);
    redactValue(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(input.token).toBe("keep-original");
  });

  it("handles cyclic references, throwing getters, depth and size limits", () => {
    const cyclic: Record<string, unknown> = { name: "cycle" };
    cyclic.self = cyclic;
    const cycled = redactValue(cyclic) as Record<string, unknown>;
    expect(cycled.self).toBe("[circular]");
    expect(cycled.name).toBe("cycle");

    const getterOutput = redactValue(createThrowingGetterObject()) as Record<string, unknown>;
    expect(getterOutput.safe).toBe(1);
    expect(getterOutput.boom).toBe("[getter-error]");

    const deep: Record<string, unknown> = { surface: true };
    let cursor = deep;
    for (let i = 0; i < 20; i += 1) {
      cursor.child = {};
      cursor = cursor.child as Record<string, unknown>;
    }
    const deepOutput = JSON.stringify(redactValue(deep));
    expect(deepOutput).toContain("[depth-limit]");

    const huge = { blob: "x".repeat(10_000) };
    const hugeOutput = redactValue(huge) as Record<string, unknown>;
    expect((hugeOutput.blob as string).length).toBeLessThan(10_000);
    expect(hugeOutput.blob as string).toContain("[truncated");

    const wide: Record<string, number> = {};
    for (let i = 0; i < 300; i += 1) {
      wide[`key${i}`] = i;
    }
    const wideOutput = redactValue(wide) as Record<string, unknown>;
    expect(Object.keys(wideOutput).length).toBeLessThanOrEqual(129);
    expect(wideOutput["[truncated]"]).toBe("172 more keys");
  });

  it("converts values JSON.stringify cannot encode", () => {
    const input = { big: 123456789012345678901234567890n, when: () => {}, flag: Symbol("s") };
    const output = redactValue(input) as Record<string, unknown>;
    expect(output.big).toBe("123456789012345678901234567890");
    expect(output.when).toBe("[function]");
    expect(output.flag).toBe("[symbol]");
    expect(() => JSON.stringify(output)).not.toThrow();
  });

  it("preserves shared (non-cyclic) references as independent copies", () => {
    const shared = { value: 1 };
    const input = { a: shared, b: shared };
    const output = redactValue(input) as Record<string, unknown>;
    const a = output.a as Record<string, unknown>;
    const b = output.b as Record<string, unknown>;
    expect(a).toEqual({ value: 1 });
    expect(b).toEqual({ value: 1 });
    expect(a).not.toBe(shared);
  });

  it("keeps dangerous own keys as own data properties", () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"ok":1}') as object;
    const output = redactValue(input) as Record<string, unknown>;
    expect(Object.hasOwn(output, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("serializeErrorForLog", () => {
  it("keeps name/message/stack/code and the cause chain, scrubbing paths", () => {
    const root = Object.assign(new Error("root failed"), { code: "SQLITE_BUSY" });
    const middle = new Error("middle failed", { cause: root });
    middle.stack = `Error: middle failed\n    at run (/Users/cassia/Local/Code/bellis/src/x.ts:12:34)`;
    const output = serializeErrorForLog(middle) as Record<string, unknown>;
    expect(output.name).toBe("Error");
    expect(output.message).toBe("middle failed");
    expect(output.code).toBeUndefined();
    const stack = output.stack as string;
    expect(stack).toContain("at run");
    expect(stack).not.toContain("/Users/");
    expect(stack).toContain("<path>");
    const cause = output.cause as Record<string, unknown>;
    expect(cause.code).toBe("SQLITE_BUSY");
    expect(cause.message).toBe("root failed");
  });

  it("redacts sensitive fields on errors and bounds cause depth", () => {
    const fifth = new Error("fifth");
    const fourth = new Error("fourth", { cause: fifth });
    const third = new Error("third", { cause: fourth });
    const second = new Error("second", { cause: third });
    const first = Object.assign(new Error("first", { cause: second }), {
      password: "do-not-leak",
    });
    const output = serializeErrorForLog(first) as Record<string, unknown>;
    expect(output.password).toBe("[redacted]");
    const level1 = output.cause as Record<string, unknown>;
    const level2 = level1.cause as Record<string, unknown>;
    const level3 = level2.cause as Record<string, unknown>;
    expect(level3.message).toBe("fourth");
    // cause 链最多展开 3 层，第五层不进入日志。
    expect(level3.cause).toBeUndefined();
    expect(JSON.stringify(output)).not.toContain("do-not-leak");
    expect(JSON.stringify(output)).not.toContain("fifth");
  });

  it("survives error cause cycles", () => {
    const err = new Error("cycle");
    (err as { cause?: unknown }).cause = err;
    const output = serializeErrorForLog(err) as Record<string, unknown>;
    expect(output.cause).toBe("[circular]");
  });
});

describe("redaction property: arbitrary JSON payloads", () => {
  it("never lets a secret placed under a sensitive key escape, and keeps the rest intact", () => {
    const casingArb = fc.constantFrom("upper", "lower", "mixed");
    const sensitiveNameArb = fc.integer({ min: 0, max: SENSITIVE_LOG_FIELD_NAMES.length - 1 });
    fc.assert(
      fc.property(
        fc.json({ maxDepth: 6 }),
        casingArb,
        sensitiveNameArb,
        (jsonText, casing, nameIndex) => {
          const baseName = SENSITIVE_LOG_FIELD_NAMES[nameIndex] ?? "token";
          const secret = "zz-secret-7f3a1";
          const key =
            casing === "upper"
              ? baseName.toUpperCase()
              : casing === "mixed"
                ? baseName[0] === undefined
                  ? baseName
                  : baseName[0].toUpperCase() + baseName.slice(1)
                : baseName;
          const input = JSON.parse(`{"${key}":"${secret}","wrapped":${jsonText}}`) as unknown;
          const output = JSON.stringify(redactValue(input));
          expect(output).not.toContain(secret);
          const parsed = JSON.parse(output) as Record<string, unknown>;
          expect(parsed[key]).toBe("[redacted]");
          expect(parsed.wrapped).toEqual(JSON.parse(jsonText));
        },
      ),
      { numRuns: 200 },
    );
  });
});
