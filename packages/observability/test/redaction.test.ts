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

  it("replaces throwing array index getters with [getter-error] (评审 2-P2)", () => {
    const arr = [1, 2, 3];
    Object.defineProperty(arr, 1, {
      get() {
        throw new Error("array getter");
      },
      configurable: true,
    });
    // 直接调用公开入口与嵌套在对象里两种形态都不抛错，其余元素保留。
    expect(redactValue(arr)).toEqual([1, "[getter-error]", 3]);
    const wrapped = redactValue({ arr }) as Record<string, unknown>;
    expect(wrapped.arr).toEqual([1, "[getter-error]", 3]);

    const trapped = new Proxy([7], {
      get(target, prop) {
        if (prop === "0") {
          throw new Error("proxy array getter");
        }
        return Reflect.get(target, prop);
      },
    });
    expect(redactValue(trapped)).toEqual(["[getter-error]"]);
  });

  it("degrades unforeseen traps to [redaction-error] without throwing from the public entry", () => {
    // instanceof 会触发 Proxy 的 getPrototypeOf 陷阱——这是逐项保护覆盖不到的
    // 路径，最终兜底必须接住（直接调用与嵌套两种形态）。
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("prototype trap");
        },
      },
    );
    expect(redactValue(hostile)).toBe("[redaction-error]");
    const wrapped = redactValue({ hostile }) as Record<string, unknown>;
    expect(wrapped.hostile).toBe("[redaction-error]");
  });

  it("keeps Error own properties and the cause inside safe recursion (评审 3-P2-1)", () => {
    // 敌意对象藏在 Error 自有属性或 cause 里：属性读取本身受保护，但其
    // 递归净化若不走 safeRedactNode，公开 serializeErrorForLog 会被穿透。
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("nested trap");
        },
      },
    );
    const withHostileProperty = Object.assign(new Error("boom"), { meta: hostile });
    const direct = serializeErrorForLog(withHostileProperty) as Record<string, unknown>;
    expect(direct.meta).toBe("[redaction-error]");
    expect(direct.message).toBe("boom");
    const viaValue = redactValue(withHostileProperty) as Record<string, unknown>;
    expect(viaValue.meta).toBe("[redaction-error]");
    expect(viaValue.message).toBe("boom");

    const withHostileCause = new Error("wrapped");
    withHostileCause.cause = hostile;
    const causeOutput = serializeErrorForLog(withHostileCause) as Record<string, unknown>;
    expect(causeOutput.cause).toBe("[redaction-error]");
    expect(causeOutput.message).toBe("wrapped");
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

  it("survives throwing name/message/stack/cause getters on errors (评审 P1-2)", () => {
    const hostile = new Error("real message");
    Object.defineProperty(hostile, "name", {
      get() {
        throw new Error("name getter");
      },
      configurable: true,
    });
    Object.defineProperty(hostile, "stack", {
      get() {
        throw new Error("stack getter");
      },
      configurable: true,
    });
    Object.defineProperty(hostile, "cause", {
      get() {
        throw new Error("cause getter");
      },
      configurable: true,
    });
    const output = serializeErrorForLog(hostile) as Record<string, unknown>;
    expect(output.name).toBe("[getter-error]");
    expect(output.message).toBe("real message");
    expect(output.stack).toBe("[getter-error]");
    expect(output.cause).toBeUndefined();

    const hostileMessage = new Error("x");
    Object.defineProperty(hostileMessage, "message", {
      get() {
        throw new Error("message getter");
      },
      configurable: true,
    });
    const output2 = serializeErrorForLog(hostileMessage) as Record<string, unknown>;
    expect(output2.message).toBe("[getter-error]");
  });

  it("scrubs absolute paths containing spaces and Windows drive letters (评审 P2-6)", () => {
    const stack = [
      "Error: boom",
      "    at run (/Users/cassia/My Project/secret file.ts:12:34)",
      "    at load (C:\\Users\\me\\App Data\\roaming\\cfg.json:1:2)",
      "    at unc (\\\\server\\share\\mod.js:3:4)",
      "    at relative (src/plain.ts:5:6)",
    ].join("\n");
    const output = serializeErrorForLog(Object.assign(new Error("boom"), { stack }));
    const scrubbed = output.stack as string;
    expect(scrubbed).toContain("at run");
    expect(scrubbed).toContain("<path>");
    // 空格路径、盘符路径、UNC 路径的任何片段都不再泄露。
    for (const leaked of [
      "/Users/",
      "My Project",
      "secret file.ts",
      "C:\\",
      "App Data",
      "roaming",
      "\\\\server",
      "share",
    ]) {
      expect(scrubbed).not.toContain(leaked);
    }
  });

  it("scrubs single-segment absolute paths but keeps word-internal separators (评审 2-P2)", () => {
    const stack = [
      "Error: keep and/or, date 2026/08/20, ratio a / b",
      "    at single (/secret.ts:1:1)",
      "    at win (C:\\secret.ts:2:2)",
      "    at unc (\\\\share\\cfg.ini:3:3)",
      "    at relative (src/a/b.ts:4:4)",
    ].join("\n");
    const output = serializeErrorForLog(Object.assign(new Error("keep"), { stack }));
    const scrubbed = output.stack as string;
    expect(scrubbed).toContain("at single (<path>)");
    expect(scrubbed).toContain("at win (<path>)");
    expect(scrubbed).toContain("at unc (<path>)");
    expect(scrubbed).not.toContain("secret.ts");
    expect(scrubbed).not.toContain("cfg.ini");
    // 单词内分隔符、无路径语义的空格斜杠与相对路径不受影响。
    expect(scrubbed).toContain("and/or");
    expect(scrubbed).toContain("2026/08/20");
    expect(scrubbed).toContain("a / b");
    expect(scrubbed).toContain("src/a/b.ts");
  });

  it("scrubs single-segment paths with spaces anchored by :line:column (评审 3-P2-2)", () => {
    // 单段 + 含空格的文件名没有第二个分隔符可供多段分支锚定；以 V8 堆栈
    // 位置的 `:line:column` 收尾作锚，整段替换，` file.ts` 后缀不残留。
    const stack = [
      "Error: spaced",
      "    at spaced (/secret file.ts:1:1)",
      "    at win (C:\\secret file.ts:2:2)",
      "    at plain (/secret.ts:3:3)",
    ].join("\n");
    const output = serializeErrorForLog(Object.assign(new Error("spaced"), { stack }));
    const scrubbed = output.stack as string;
    expect(scrubbed).toContain("at spaced (<path>)");
    expect(scrubbed).toContain("at win (<path>)");
    expect(scrubbed).toContain("at plain (<path>)");
    expect(scrubbed).not.toContain("secret");
    expect(scrubbed).not.toContain("file.ts");
    // 普通文本里的空格斜杠不受 :line:column 分支影响。
    expect(scrubbed).toContain("Error: spaced");
  });

  it("degrades unenumerable (proxy-trapped) objects and invalid dates stably", () => {
    const proxied = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("ownKeys trap");
        },
      },
    );
    const output = redactValue({ proxied, ok: 1 }) as Record<string, unknown>;
    expect(output.proxied).toEqual({ "[unenumerable]": true });
    expect(output.ok).toBe(1);

    const invalidDate = new Date("not-a-date");
    const withDate = redactValue({ invalidDate }) as Record<string, unknown>;
    expect(withDate.invalidDate).toBe("[invalid-date]");
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
