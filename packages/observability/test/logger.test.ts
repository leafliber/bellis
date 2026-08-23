import { describe, expect, it } from "vitest";
import { createPinoLogger } from "../src/index.js";
import type { LoggerDestination } from "../src/index.js";

function createMemoryDestination(): { destination: LoggerDestination; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    destination: {
      write: (line) => {
        lines.push(line);
      },
    },
  };
}

function parseLine(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

describe("createPinoLogger", () => {
  it("emits time, level, service, version and event on every line", () => {
    const { lines, destination } = createMemoryDestination();
    const logger = createPinoLogger({
      service: "bellis-runtime",
      version: "0.1.0",
      level: "trace",
      destination,
    });
    logger.log("info", "runtime.started", { port: 17890 });
    expect(lines).toHaveLength(1);
    const line = parseLine(lines[0] ?? "");
    expect(line.event).toBe("runtime.started");
    expect(line.level).toBe("info");
    expect(line.service).toBe("bellis-runtime");
    expect(line.version).toBe("0.1.0");
    expect(typeof line.time).toBe("number");
    expect(line.port).toBe(17890);
  });

  it("supports all five levels and filters below the configured level", () => {
    const { lines, destination } = createMemoryDestination();
    const logger = createPinoLogger({
      service: "svc",
      version: "1",
      level: "warn",
      destination,
    });
    for (const level of ["trace", "debug", "info", "warn", "error"] as const) {
      logger.log(level, `event.${level}`);
    }
    const levels = lines.map((line) => parseLine(line).level);
    expect(levels).toEqual(["warn", "error"]);
  });

  it("merges child fields and lets child() nest", () => {
    const { lines, destination } = createMemoryDestination();
    const logger = createPinoLogger({
      service: "svc",
      version: "1",
      level: "info",
      destination,
    });
    const session = logger.child({ sessionId: "11111111-1111-4111-8111-111111111111" });
    const cycle = session.child({ cycleId: "33333333-3333-4333-8333-333333333333" });
    cycle.log("info", "scene.commit.ok", { sceneId: "22222222-2222-4222-8222-222222222222" });
    const line = parseLine(lines[0] ?? "");
    expect(line.sessionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(line.cycleId).toBe("33333333-3333-4333-8333-333333333333");
    expect(line.sceneId).toBe("22222222-2222-4222-8222-222222222222");
    expect(line.event).toBe("scene.commit.ok");
    // 父 Logger 不受子字段污染。
    logger.log("info", "after.child");
    expect(parseLine(lines[1] ?? "").sessionId).toBeUndefined();
  });

  it("protects service/version/event from caller and child overrides", () => {
    const { lines, destination } = createMemoryDestination();
    const logger = createPinoLogger({
      service: "svc",
      version: "1",
      level: "info",
      destination,
    });
    logger.log("info", "real.event", { event: "fake.event", service: "evil", version: "9" });
    const child = logger.child({ service: "child-evil", requestId: "req-1" });
    child.log("warn", "child.event");
    const first = parseLine(lines[0] ?? "");
    const second = parseLine(lines[1] ?? "");
    expect(first.event).toBe("real.event");
    expect(first.service).toBe("svc");
    expect(first.version).toBe("1");
    expect(second.service).toBe("svc");
    expect(second.requestId).toBe("req-1");
  });

  it("serializes errors with cause chain through redaction", () => {
    const { lines, destination } = createMemoryDestination();
    const logger = createPinoLogger({
      service: "svc",
      version: "1",
      level: "info",
      destination,
    });
    const root = Object.assign(new Error("root failed"), { code: "SQLITE_BUSY" });
    const wrapped = new Error("wrapped", { cause: root });
    logger.log("error", "db.operation.failed", {
      err: wrapped,
      token: "super-secret-token",
    });
    const line = parseLine(lines[0] ?? "");
    const err = line.err as Record<string, unknown>;
    expect(err.message).toBe("wrapped");
    const cause = err.cause as Record<string, unknown>;
    expect(cause.code).toBe("SQLITE_BUSY");
    expect(line.token).toBe("[redacted]");
    expect(lines[0]).not.toContain("super-secret-token");
  });

  it("degrades silently when the destination fails, never throws to callers", () => {
    let writes = 0;
    const destination: LoggerDestination = {
      write: () => {
        writes += 1;
        throw new Error("EPIPE");
      },
    };
    const logger = createPinoLogger({ service: "svc", version: "1", level: "info", destination });
    expect(() => logger.log("info", "first")).not.toThrow();
    expect(() => logger.log("error", "second")).not.toThrow();
    expect(() => logger.child({ a: 1 }).log("warn", "third")).not.toThrow();
    // 第一次写入失败后进入降级：不再尝试写入。
    expect(writes).toBe(1);
  });

  it("rejects invalid factory options at assembly time", () => {
    expect(() =>
      createPinoLogger({
        service: "",
        version: "1",
        level: "info",
        destination: createMemoryDestination().destination,
      }),
    ).toThrow(RangeError);
    expect(() =>
      createPinoLogger({
        service: "svc",
        version: "",
        level: "info",
        destination: createMemoryDestination().destination,
      }),
    ).toThrow(RangeError);
  });

  it("serializes every line as JSON without throwing on hostile fields", () => {
    const { lines, destination } = createMemoryDestination();
    const logger = createPinoLogger({ service: "svc", version: "1", level: "trace", destination });
    const cyclic: Record<string, unknown> = { name: "c" };
    cyclic.self = cyclic;
    expect(() =>
      logger.log("info", "hostile.fields", {
        cyclic,
        big: 9_007_199_254_740_993n,
        deep: { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 1 } } } } } } } } } },
      }),
    ).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0] ?? "")).not.toThrow();
  });

  it("never throws on throwing getters in top-level fields (评审 P1-2)", () => {
    const { lines, destination } = createMemoryDestination();
    const logger = createPinoLogger({ service: "svc", version: "1", level: "info", destination });
    const fields: Record<string, unknown> = {
      safe: 7,
      get boom(): number {
        throw new Error("getter escaped");
      },
    };
    expect(() => logger.log("info", "getter.field", fields)).not.toThrow();
    const line = parseLine(lines[0] ?? "");
    expect(line.event).toBe("getter.field");
    expect(line.safe).toBe(7);
    expect(line.boom).toBe("[getter-error]");
    // 后续日志不受单次坏字段影响。
    expect(() => logger.log("info", "next.event", { ok: true })).not.toThrow();
    expect(parseLine(lines[1] ?? "").ok).toBe(true);
  });

  it("never throws on child() with throwing getters, dropping only the hostile field", () => {
    const { lines, destination } = createMemoryDestination();
    const logger = createPinoLogger({ service: "svc", version: "1", level: "info", destination });
    const hostile: Record<string, unknown> = {
      requestId: "req-9",
      get evil(): string {
        throw new Error("child getter");
      },
    };
    let child: ReturnType<typeof logger.child> | undefined;
    expect(() => {
      child = logger.child(hostile);
    }).not.toThrow();
    expect(() => child?.log("warn", "child.event")).not.toThrow();
    const line = parseLine(lines[0] ?? "");
    expect(line.event).toBe("child.event");
    expect(line.requestId).toBe("req-9");
    expect(line.evil).toBe("[getter-error]");
  });

  it("never throws on proxy-trapped fields objects or hostile error accessors", () => {
    const { lines, destination } = createMemoryDestination();
    const logger = createPinoLogger({ service: "svc", version: "1", level: "info", destination });
    const trapped = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("ownKeys trap");
        },
      },
    );
    expect(() => logger.log("info", "proxy.fields", trapped)).not.toThrow();
    expect(parseLine(lines[0] ?? "").event).toBe("proxy.fields");

    const hostileError = new Error("real");
    Object.defineProperty(hostileError, "stack", {
      get() {
        throw new Error("stack getter");
      },
      configurable: true,
    });
    expect(() => logger.log("error", "hostile.error", { err: hostileError })).not.toThrow();
    const err = parseLine(lines[1] ?? "").err as Record<string, unknown>;
    expect(err.message).toBe("real");
    expect(err.stack).toBe("[getter-error]");
  });
});

describe("credential content scrubbing (Gate 3 重开评审修复 1)", () => {
  it("never emits credential values embedded in free-text fields or error objects", () => {
    const { lines, destination } = createMemoryDestination();
    const logger = createPinoLogger({
      service: "bellis-runtime",
      version: "0.1.0",
      level: "info",
      destination,
    });
    const canary = "CANARY_1f8e2d6b9a4c3770";
    const error = new Error(`denied for Authorization: Bearer ${canary}`);
    // Runtime 的常见日志形态：error 字段承载任意 error.message（普通字段名，
    // 键级匹配不覆盖），以及直接序列化的 Error 对象。
    logger.log("warn", "runtime_request_error_after_sent", { error: error.message });
    logger.log("error", "runtime_unexpected_error", { errorObject: error });
    const text = lines.join("\n");
    expect(text).not.toContain(canary);
    expect(text).toContain("[redacted]");
  });
});

describe("free-text credential scrubbing round 2 (Gate 3 复审修复)", () => {
  it("scrubs the six leaked forms from the previous round on the real Pino assembly", () => {
    const { lines, destination } = createMemoryDestination();
    const logger = createPinoLogger({
      service: "bellis-runtime",
      version: "0.1.0",
      level: "info",
      destination,
    });
    const canary = "CANARY_3c8f1e5b7a2d9046";
    const probes: ReadonlyArray<[label: string, text: string]> = [
      ["multiCookie", `Cookie: benign=1; bellis_session=${canary}`],
      ["customAuthorization", `Authorization: Custom ${canary}`],
      ["camelStartupToken", `startupToken=${canary}`],
      ["underscoreAccessToken", `access_token=${canary}`],
      ["credentials", `credentials=${canary}`],
      ["digest", `Authorization: Digest username="alice", response="${canary}"`],
    ];
    for (const [label, text] of probes) {
      // Runtime 的常见形态：error 字段承载任意 error.message，以及直接
      // 序列化的 Error 对象（message/stack 走同一内容级清理）。
      logger.log("warn", `probe_field_${label}`, { error: text });
      logger.log("error", `probe_object_${label}`, { errorObject: new Error(text) });
    }
    const text = lines.join("\n");
    expect(text).not.toContain(canary);
    expect((text.match(/\[redacted\]/g) ?? []).length).toBeGreaterThanOrEqual(12);
  });
});

describe("free-text credential scrubbing round 3 (Gate 3 三审修复)", () => {
  it("scrubs escaped-JSON keys and multi-word values on the real Pino assembly", () => {
    const { lines, destination } = createMemoryDestination();
    const logger = createPinoLogger({
      service: "bellis-runtime",
      version: "0.1.0",
      level: "info",
      destination,
    });
    const canary = "CANARY_6b0e9d3a7f5c2148";
    const probes: ReadonlyArray<[label: string, text: string]> = [
      ["escaped_field", `payload="{\\"authorization\\":\\"${canary}\\"}"`],
      ["escaped_object", `detail='{\\"access_token\\": \\"${canary}\\"}'`],
      ["multiwordCredentials", `credentials=alice ${canary}`],
      ["multiwordPassword", `password=correct horse ${canary}`],
    ];
    for (const [label, text] of probes) {
      // 与上一轮相同的两条路径：error 字段承载任意自由文本，以及直接
      // 序列化的 Error 对象（message/stack 走同一内容级清理）。
      logger.log("warn", `probe_field_${label}`, { error: text });
      logger.log("error", `probe_object_${label}`, { errorObject: new Error(text) });
    }
    const text = lines.join("\n");
    expect(text).not.toContain(canary);
    expect((text.match(/\[redacted\]/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });
});

describe("free-text credential scrubbing round 4 (Gate 3 四审修复)", () => {
  it("scrubs field-canonical name variants and nested-stringify keys on the real Pino assembly", () => {
    const { lines, destination } = createMemoryDestination();
    const logger = createPinoLogger({
      service: "bellis-runtime",
      version: "0.1.0",
      level: "info",
      destination,
    });
    const canary = "CANARY_4f7b2e9a6d1c8530";
    // 评审者构造：JSON.stringify({payload: JSON.stringify({payload:
    // JSON.stringify({authorization: canary})})})——键关闭引号前为 3 个
    // 反斜杠，单层 \\? 转义匹配在此形态失效。
    let nested = JSON.stringify({ authorization: canary });
    nested = JSON.stringify({ payload: nested });
    nested = JSON.stringify({ payload: nested });
    const probes: ReadonlyArray<[label: string, text: string]> = [
      ["dottedAuthorization", `author.ization=${canary}`],
      ["slashedAuthorization", `auth/orization=${canary}`],
      ["dottedApiKey", `api.key=${canary}`],
      ["nestedStringify", nested],
    ];
    for (const [label, text] of probes) {
      logger.log("warn", `probe_field_${label}`, { error: text });
      logger.log("error", `probe_object_${label}`, { errorObject: new Error(text) });
    }
    const text = lines.join("\n");
    expect(text).not.toContain(canary);
    expect((text.match(/\[redacted\]/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });
});

describe("free-text credential scrubbing round 5 (Gate 3 五审修复)", () => {
  it("scrubs \\uXXXX-escaped keys on the real Pino assembly", () => {
    const { lines, destination } = createMemoryDestination();
    const logger = createPinoLogger({
      service: "bellis-runtime",
      version: "0.1.0",
      level: "info",
      destination,
    });
    const canary = "CANARY_5d9c3f8a2e7b1460";
    // 嵌套两层 stringify：转义反斜杠翻倍为 4 个。
    let nested = `{"author\\u0069zation":"${canary}"}`;
    nested = JSON.stringify({ payload: nested });
    nested = JSON.stringify({ payload: nested });
    const probes: ReadonlyArray<[label: string, text: string]> = [
      ["escapedNameCharI", `{"author\\u0069zation":"${canary}"}`],
      ["escapedFirstChar", `{"\\u0061uthorization":"${canary}"}`],
      ["escapedSeparator", `{"author\\u002eization":"${canary}"}`],
      ["escapedNested", nested],
    ];
    for (const [label, text] of probes) {
      logger.log("warn", `probe_field_${label}`, { error: text });
      logger.log("error", `probe_object_${label}`, { errorObject: new Error(text) });
    }
    const text = lines.join("\n");
    expect(text).not.toContain(canary);
    expect((text.match(/\[redacted\]/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });
});

describe("free-text credential scrubbing round 6 (Gate 3 六审修复)", () => {
  it("scrubs JSON short-escape forms on the real Pino assembly", () => {
    const { lines, destination } = createMemoryDestination();
    const logger = createPinoLogger({
      service: "bellis-runtime",
      version: "0.1.0",
      level: "info",
      destination,
    });
    const canary = "CANARY_1e8a6d4b9f3c7205";
    let nested = JSON.stringify({ ["auth\torization"]: canary });
    nested = JSON.stringify({ payload: nested });
    const probes: ReadonlyArray<[label: string, text: string]> = [
      ["stringifyTabKey", JSON.stringify({ ["auth\torization"]: canary })],
      ["stringifyBackspaceKey", JSON.stringify({ ["auth\borization"]: canary })],
      ["schemeShortTab", `Bearer\\t${canary}`],
      ["schemeEscapedTab", `Bearer\\u0009${canary}`],
      ["nestedShortEscape", nested],
    ];
    for (const [label, text] of probes) {
      logger.log("warn", `probe_field_${label}`, { error: text });
      logger.log("error", `probe_object_${label}`, { errorObject: new Error(text) });
    }
    const text = lines.join("\n");
    expect(text).not.toContain(canary);
    expect((text.match(/\[redacted\]/g) ?? []).length).toBeGreaterThanOrEqual(10);
  });
});
