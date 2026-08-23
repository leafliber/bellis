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

/** 字符的 JSON Unicode 转义源文本（\uXXXX）。 */
function escapeCode(char: string): string {
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

/**
 * 性质测试的 canary 生成器：固定高熵前缀 + 随机片段。裸随机片段可能与
 * Error stack/路径/框架文本偶然重合（如 `operty` 命中 fast-check 的
 * `Property.predicate`），造成随机假失败（六审 P2）。
 */
const canaryTokenArb = fc
  .stringMatching(/^[A-Za-z0-9_\-.=+/]{6,42}$/)
  .map((suffix) => `CANARY_${suffix}`);

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

describe("content-level scrubbing (Gate 3 重开评审修复 1)", () => {
  const CANARY = "CANARY_7a3f9d1c4e2b5860";

  it("scrubs Authorization/Bearer credentials embedded in free text", () => {
    const output = JSON.stringify(
      redactValue({ error: `request rejected: Authorization: Bearer ${CANARY}` }),
    );
    expect(output).not.toContain(CANARY);
    expect(output).toContain("[redacted]");
  });

  it("serializes Errors without leaking credentials in message or stack", () => {
    const error = new Error(`exchange failed for Bearer ${CANARY}`);
    error.stack = `Error: exchange failed for Bearer ${CANARY}\n    at /tmp/secret.js:1:1`;
    const output = JSON.stringify(serializeErrorForLog(error));
    expect(output).not.toContain(CANARY);
    const parsed = JSON.parse(output) as { message: string; stack: string };
    expect(parsed.message).toContain("[redacted]");
    expect(parsed.stack).toContain("<path>");
  });

  it("scrubs token key-value forms in prose while keeping ordinary text intact", () => {
    const scrubbed = JSON.stringify(redactValue({ detail: `startup token: ${CANARY}` }));
    expect(scrubbed).not.toContain(CANARY);
    expect(scrubbed).toContain("[redacted]");

    const intact = { note: "request failed at boundary validation", seq: "42", ok: true };
    expect(JSON.parse(JSON.stringify(redactValue(intact)))).toEqual(intact);
  });

  it("property: Bearer credentials with token-charset values never survive", () => {
    fc.assert(
      fc.property(canaryTokenArb, (token) => {
        const output = JSON.stringify(
          serializeErrorForLog(new Error(`Authorization: Bearer ${token}`)),
        );
        expect(output.includes(token)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

describe("content-level scrubbing round 2 (Gate 3 复审修复)", () => {
  const CANARY = "CANARY_2e6b9d4a1f8c3750";

  const PROBES: ReadonlyArray<[label: string, text: string]> = [
    ["multiCookie", `Cookie: benign=1; bellis_session=${CANARY}`],
    ["customAuthorization", `Authorization: Custom ${CANARY}`],
    ["camelStartupToken", `startupToken=${CANARY}`],
    ["underscoreAccessToken", `access_token=${CANARY}`],
    ["credentials", `credentials=${CANARY}`],
    ["digest", `Authorization: Digest username="alice", response="${CANARY}"`],
  ];

  it("scrubs all six probe forms in string fields and Error messages", () => {
    for (const [label, text] of PROBES) {
      const fieldOut = JSON.stringify(redactValue({ error: text }));
      expect(fieldOut.includes(CANARY), label).toBe(false);
      const errorOut = JSON.stringify(serializeErrorForLog(new Error(text)));
      expect(errorOut.includes(CANARY), label).toBe(false);
    }
  });

  it("header values are consumed to end of line without touching the next line", () => {
    const input = `exchange failed\nCookie: a=1; b=${CANARY}\nnext line stays readable`;
    const output = JSON.stringify(redactValue({ detail: input })) as string;
    expect(output.includes(CANARY)).toBe(false);
    expect(output).toContain("next line stays readable");
    expect(output).toContain("exchange failed");
  });

  it("property: sensitive key names in any naming style never leak values", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: SENSITIVE_LOG_FIELD_NAMES.length - 1 }),
        fc.integer({ min: 1, max: 20 }),
        fc.constantFrom("", "_", "-", " "),
        fc.constantFrom(":", "="),
        canaryTokenArb,
        fc.boolean(),
        fc.boolean(),
        (nameIndex, splitAt, separator, sepChar, token, upperCase, asError) => {
          const baseName = SENSITIVE_LOG_FIELD_NAMES[nameIndex] ?? "token";
          const canonical = baseName.toLowerCase().replace(/[^a-z0-9]/g, "");
          const clamped = Math.min(Math.max(splitAt, 1), canonical.length - 1);
          const styled = canonical.slice(0, clamped) + separator + canonical.slice(clamped);
          const name = upperCase ? styled.toUpperCase() : styled;
          const text = `${name}${sepChar} ${token}`;
          const output = asError
            ? JSON.stringify(serializeErrorForLog(new Error(`probe ${text}`)))
            : JSON.stringify(redactValue({ detail: text }));
          expect(output.includes(token)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("content-level scrubbing round 3 (Gate 3 三审修复)", () => {
  const CANARY = "CANARY_9d4a2f7e5c1b8360";

  const PROBES: ReadonlyArray<[label: string, text: string]> = [
    ["escaped_field", `payload="{\\"authorization\\":\\"${CANARY}\\"}"`],
    ["escaped_object", `detail='{\\"access_token\\": \\"${CANARY}\\"}'`],
    ["multiwordCredentials", `credentials=alice ${CANARY}`],
    ["multiwordPassword", `password=correct horse ${CANARY}`],
  ];

  it("scrubs escaped-JSON keys and multi-word values in string fields and Errors", () => {
    for (const [label, text] of PROBES) {
      const fieldOut = JSON.stringify(redactValue({ error: text }));
      expect(fieldOut.includes(CANARY), label).toBe(false);
      expect(fieldOut.includes("[redacted]"), label).toBe(true);
      // Error 对象：message 与 stack 走同一内容级清理（stack 经
      // safeReadString → sanitizeLogText 之后再 scrubPaths）。
      const errorOut = JSON.stringify(serializeErrorForLog(new Error(text)));
      expect(errorOut.includes(CANARY), label).toBe(false);
      expect(errorOut.includes("[redacted]"), label).toBe(true);
    }
  });

  it("never assembles sensitive names across line breaks (三审 P2)", () => {
    // 名称字符间隔只允许行内空白/下划线/连字符：`t` + 换行 + `oken`
    // 不得拼成 `token` 去修改第二行——第二行不是敏感键，必须原样保留。
    for (const lineBreak of ["\n", "\r\n", "\r"]) {
      const text = `first line ends t${lineBreak}oken: ${CANARY}`;
      const output = JSON.stringify(redactValue({ detail: text }));
      expect(output).toContain(`oken: ${CANARY}`);
      expect(output).not.toContain("[redacted]");
    }
  });

  it("property: escaped-JSON keys and canary-in-later-word values never leak", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: SENSITIVE_LOG_FIELD_NAMES.length - 1 }),
        fc.constantFrom(":", "="),
        canaryTokenArb,
        fc.integer({ min: 0, max: 3 }),
        fc.boolean(),
        (nameIndex, sepChar, token, canaryAt, asError) => {
          const baseName = SENSITIVE_LOG_FIELD_NAMES[nameIndex] ?? "token";
          const canonical = baseName.toLowerCase().replace(/[^a-z0-9]/g, "");
          const filler = ["alpha", "beta", "gamma"];
          // 凭证位于多词值的第 1~4 个词（上一轮的反例正在第二个词起）。
          const words = [...filler.slice(0, canaryAt), token, ...filler.slice(canaryAt)];
          const escaped = `meta="{\\"${canonical}\\":\\"${words.join(" ")}\\"}"`;
          const plain = `${canonical}${sepChar} ${words.join(" ")}`;
          for (const text of [escaped, plain]) {
            const output = asError
              ? JSON.stringify(serializeErrorForLog(new Error(`probe ${text}`)))
              : JSON.stringify(redactValue({ error: text }));
            expect(output.includes(token)).toBe(false);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("content-level scrubbing round 4 (Gate 3 四审修复)", () => {
  const CANARY = "CANARY_8c3e6a1d5f9b2740";

  const PROBES: ReadonlyArray<[label: string, text: string]> = [
    ["dottedAuthorization", `author.ization=${CANARY}`],
    ["slashedAuthorization", `auth/orization=${CANARY}`],
    ["dottedApiKey", `api.key=${CANARY}`],
  ];

  it("normalizes names like the field-level rule: any non-alphanumeric filler", () => {
    // canonicalFieldName 移除全部非字母数字；自由文本匹配必须同语义，
    // 否则 author.ization / auth/orization / api.key 绕过内容级清理。
    for (const [label, text] of PROBES) {
      const fieldOut = JSON.stringify(redactValue({ error: text }));
      expect(fieldOut.includes(CANARY), label).toBe(false);
      const errorOut = JSON.stringify(serializeErrorForLog(new Error(text)));
      expect(errorOut.includes(CANARY), label).toBe(false);
    }
  });

  it("scrubs keys behind arbitrarily long escape runs from nested stringify", () => {
    // 每层 JSON.stringify 使键关闭引号前的反斜杠序列翻倍再增一（1→3→7→15），
    // 固定层数的 \\? 枚举必然漏层；填充按字符类吸收任意长度。
    let nested = JSON.stringify({ authorization: CANARY });
    for (let depth = 1; depth <= 4; depth += 1) {
      nested = JSON.stringify({ payload: nested });
      const fieldOut = JSON.stringify(redactValue({ error: `probe ${nested}` }));
      expect(fieldOut.includes(CANARY), `depth${depth}`).toBe(false);
      const errorOut = JSON.stringify(serializeErrorForLog(new Error(`probe ${nested}`)));
      expect(errorOut.includes(CANARY), `depth${depth}`).toBe(false);
    }
  });

  it("property: names styled by the field-level canonicalization never leak", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: SENSITIVE_LOG_FIELD_NAMES.length - 1 }),
        fc.array(fc.stringMatching(/^[^\n\rA-Za-z0-9]{1,3}$/), {
          minLength: 17,
          maxLength: 17,
        }),
        fc.constantFrom(":", "="),
        canaryTokenArb,
        fc.boolean(),
        (nameIndex, fillers, sepChar, token, asError) => {
          const baseName = SENSITIVE_LOG_FIELD_NAMES[nameIndex] ?? "token";
          const canonical = baseName.toLowerCase().replace(/[^a-z0-9]/g, "");
          let styled = "";
          canonical.split("").forEach((ch, i) => {
            styled += (i === 0 ? "" : (fillers[i] ?? ".")) + ch;
          });
          const text = `${styled}${sepChar} ${token}`;
          const output = asError
            ? JSON.stringify(serializeErrorForLog(new Error(`probe ${text}`)))
            : JSON.stringify(redactValue({ error: text }));
          expect(output.includes(token)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("property: nested JSON.stringify depth 0-3 never leaks", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3 }),
        fc.constantFrom("authorization", "accessToken", "startupToken"),
        canaryTokenArb,
        fc.boolean(),
        (depth, key, token, asError) => {
          let payload = JSON.stringify({ [key]: token });
          for (let level = 0; level < depth; level += 1) {
            payload = JSON.stringify({ payload });
          }
          const output = asError
            ? JSON.stringify(serializeErrorForLog(new Error(`body ${payload}`)))
            : JSON.stringify(redactValue({ error: payload }));
          expect(output.includes(token)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("anchors at the first separator and never keeps punctuation-only values in the preserved group", () => {
    // 贪婪填充会锚定到纯标点值内部的最后一个 `=`/`:`，把凭证保留进
    // 捕获组（四审实现期间由 round 2/3 性质测试的纯标点 token 捕获）。
    const PUNCT_PROBES: ReadonlyArray<[label: string, text: string, value: string]> = [
      ["colonRun", "authorization: -.___=", "-.___="],
      ["eqRun", "token=+++===", "+++="],
      ["dotRun", "secret:..::..", "..::.."],
      ["escaped", `meta="{\\"authorization\\":\\"_++_+=\\"}"`, "_++_+="],
    ];
    for (const [label, text, value] of PUNCT_PROBES) {
      const output = JSON.stringify(redactValue({ error: text }));
      expect(output, label).toContain("[redacted]");
      expect(output.includes(value), label).toBe(false);
    }
  });
});

describe("content-level scrubbing round 5 (Gate 3 五审修复)", () => {
  const CANARY = "CANARY_2a8f5e7c4b1d9630";

  const PROBES: ReadonlyArray<[label: string, text: string]> = [
    ["escapedNameCharI", `{"author\\u0069zation":"${CANARY}"}`],
    ["escapedFirstChar", `{"\\u0061uthorization":"${CANARY}"}`],
    ["escapedSeparator", `{"author\\u002eization":"${CANARY}"}`],
    ["escapedUpperCode", `{"\\u0041uthorization":"${CANARY}"}`],
    ["escapedColon", `authorization\\u003a ${CANARY}`],
    ["escapedEquals", `token\\u003d${CANARY}`],
  ];

  it("decodes \\uXXXX-escaped names, separators and key-value separators", () => {
    // 合法 JSON 允许把键名写成 {"author\u0069zation":…}——解码后即
    // authorization；名称字符、名称内分隔符与 :/= 分隔符的转义形态
    // 都必须识别（五审探针）。
    for (const [label, text] of PROBES) {
      const fieldOut = JSON.stringify(redactValue({ error: text }));
      expect(fieldOut.includes(CANARY), label).toBe(false);
      const errorOut = JSON.stringify(serializeErrorForLog(new Error(text)));
      expect(errorOut.includes(CANARY), label).toBe(false);
    }
  });

  it("escaped forms survive nested stringify (backslash doubling per layer)", () => {
    let nested = `{"author\\u0069zation":"${CANARY}"}`;
    for (let depth = 1; depth <= 3; depth += 1) {
      nested = JSON.stringify({ payload: nested });
      const fieldOut = JSON.stringify(redactValue({ error: nested }));
      expect(fieldOut.includes(CANARY), `depth${depth}`).toBe(false);
      const errorOut = JSON.stringify(serializeErrorForLog(new Error(nested)));
      expect(errorOut.includes(CANARY), `depth${depth}`).toBe(false);
    }
  });

  it("escaped newlines (\\u000a/\\u000d) do not join names across lines", () => {
    for (const escapedBreak of ["\\u000a", "\\u000A", "\\u000d"]) {
      const text = `first line ends t${escapedBreak}oken: ${CANARY}`;
      const output = JSON.stringify(redactValue({ detail: text }));
      expect(output).toContain(`oken: ${CANARY}`);
      expect(output).not.toContain("[redacted]");
    }
  });

  it("property: random \\uXXXX rewrites at stringify depth 0-3 never leak", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: SENSITIVE_LOG_FIELD_NAMES.length - 1 }),
        fc.array(fc.boolean(), { minLength: 18, maxLength: 18 }),
        fc.array(fc.constantFrom("none", "plain", "escape"), {
          minLength: 18,
          maxLength: 18,
        }),
        fc.array(fc.constantFrom(".", "_", "-", " "), {
          minLength: 18,
          maxLength: 18,
        }),
        fc.boolean(),
        fc.constantFrom(":", "="),
        canaryTokenArb,
        fc.integer({ min: 0, max: 3 }),
        fc.boolean(),
        (
          nameIndex,
          charEscapes,
          gapStyles,
          gapChars,
          escapeSep,
          sepChar,
          token,
          depth,
          asError,
        ) => {
          const baseName = SENSITIVE_LOG_FIELD_NAMES[nameIndex] ?? "token";
          const canonicalName = baseName.toLowerCase().replace(/[^a-z0-9]/g, "");
          let key = "";
          canonicalName.split("").forEach((char, i) => {
            const style = gapStyles[i] ?? "none";
            const gapChar = gapChars[i] ?? ".";
            key += style === "plain" ? gapChar : style === "escape" ? escapeCode(gapChar) : "";
            key += (charEscapes[i] ?? false) ? escapeCode(char) : char;
          });
          const separator = escapeSep ? escapeCode(sepChar) : sepChar;
          let payload = `{${key}${separator}"${token}"}`;
          for (let level = 0; level < depth; level += 1) {
            payload = JSON.stringify({ payload });
          }
          const output = asError
            ? JSON.stringify(serializeErrorForLog(new Error(`body ${payload}`)))
            : JSON.stringify(redactValue({ error: payload }));
          expect(output.includes(token)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("content-level scrubbing round 6 (Gate 3 六审修复)", () => {
  const CANARY = "CANARY_7b4e1d9a3f6c8520";

  it("decodes JSON short escapes (\\t/\\b/\\f) in names, anchors and scheme gaps", () => {
    // JSON.stringify 会把键中的控制字符写成短转义：\t/\b/\f 的字母部分
    // 若被当作单词边界拆散，名称无法拼装（六审探针，含评审者的
    // stringify 构造与裸 scheme 间隔）。
    const PROBES: ReadonlyArray<[label: string, text: string]> = [
      ["stringifyTabKey", JSON.stringify({ ["auth\torization"]: CANARY })],
      ["stringifyBackspaceKey", JSON.stringify({ ["auth\borization"]: CANARY })],
      ["stringifyFormfeedKey", JSON.stringify({ ["auth\forization"]: CANARY })],
      ["stringifyTabLeadKey", JSON.stringify({ ["\tauthorization"]: CANARY })],
      ["rawTabGap", `{"auth\\torization":"${CANARY}"}`],
      ["rawBackspaceGap", `auth\\borization=${CANARY}`],
      ["rawFormfeedGap", `auth\\forization=${CANARY}`],
      ["rawTabLeadAnchor", `{"\\ttoken":"${CANARY}"}`],
      ["schemeShortTab", `Bearer\\t${CANARY}`],
      ["schemeEscapedTab", `Bearer\\u0009${CANARY}`],
      ["schemeEscapedFormfeed", `Bearer\\u000c${CANARY}`],
    ];
    for (const [label, text] of PROBES) {
      const fieldOut = JSON.stringify(redactValue({ error: text }));
      expect(fieldOut.includes(CANARY), label).toBe(false);
      const errorOut = JSON.stringify(serializeErrorForLog(new Error(text)));
      expect(errorOut.includes(CANARY), label).toBe(false);
    }
  });

  it("short-escape forms survive nested stringify (backslash doubling per layer)", () => {
    let nested = JSON.stringify({ ["auth\torization"]: CANARY });
    for (let depth = 1; depth <= 3; depth += 1) {
      nested = JSON.stringify({ payload: nested });
      const fieldOut = JSON.stringify(redactValue({ error: nested }));
      expect(fieldOut.includes(CANARY), `depth${depth}`).toBe(false);
      const errorOut = JSON.stringify(serializeErrorForLog(new Error(nested)));
      expect(errorOut.includes(CANARY), `depth${depth}`).toBe(false);
    }
  });

  it("short escapes of newlines (\\n/\\r) do not join names or scheme values", () => {
    for (const [label, text] of [
      ["nameJoin", `first line ends t\\noken: ${CANARY}`],
      ["nameJoinCr", `first line ends t\\roken: ${CANARY}`],
      ["schemeGap", `Bearer\\n${CANARY}`],
    ] as const) {
      const output = JSON.stringify(redactValue({ detail: text }));
      expect(output, label).not.toContain("[redacted]");
    }
    expect(
      JSON.stringify(redactValue({ detail: `first line ends t\\noken: ${CANARY}` })),
    ).toContain(`oken: ${CANARY}`);
  });

  it("property: short-escaped gaps across all names at stringify depth 0-3 never leak", () => {
    const SHORT_ESCAPES = ["\\t", "\\b", "\\f"] as const;
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: SENSITIVE_LOG_FIELD_NAMES.length - 1 }),
        fc.array(fc.constantFrom(...SHORT_ESCAPES), { minLength: 18, maxLength: 18 }),
        canaryTokenArb,
        fc.integer({ min: 0, max: 3 }),
        fc.boolean(),
        (nameIndex, gapEscapes, token, depth, asError) => {
          const baseName = SENSITIVE_LOG_FIELD_NAMES[nameIndex] ?? "token";
          const canonicalName = baseName.toLowerCase().replace(/[^a-z0-9]/g, "");
          let key = "";
          canonicalName.split("").forEach((char, i) => {
            if (i > 0) {
              key += gapEscapes[i] ?? "\\t";
            }
            key += char;
          });
          let payload = `{${key}:"${token}"}`;
          for (let level = 0; level < depth; level += 1) {
            payload = JSON.stringify({ payload });
          }
          const output = asError
            ? JSON.stringify(serializeErrorForLog(new Error(`body ${payload}`)))
            : JSON.stringify(redactValue({ error: payload }));
          expect(output.includes(token)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});
