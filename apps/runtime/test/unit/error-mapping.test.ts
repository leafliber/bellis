import { describe, expect, it } from "vitest";
import { PersistenceError } from "@bellis/persistence";
import { ZodError, z } from "zod";
import { ApplicationError, mapErrorToEnvelope, stableRequestFingerprint } from "../../src/index.js";

const TRACE_ID = "0123456789abcdef0123456789abcdef";

describe("mapErrorToEnvelope", () => {
  it("ApplicationError 保留机器码与状态", () => {
    const mapped = mapErrorToEnvelope(
      new ApplicationError("unauthorized", "exchanged rejected"),
      TRACE_ID,
    );
    expect(mapped.code).toBe("unauthorized");
    expect(mapped.status).toBe(401);
    expect(mapped.retryable).toBe(false);
  });

  it("ZodError → invalid_message / 400", () => {
    const parsed = z.object({ a: z.string() }).safeParse({});
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }
    const mapped = mapErrorToEnvelope(new ZodError(parsed.error.issues), TRACE_ID);
    expect(mapped.code).toBe("invalid_message");
    expect(mapped.status).toBe(400);
    expect(mapped.message).not.toContain("at line");
  });

  it("PersistenceError 映射稳定且不透出 SQL/路径", () => {
    const mapped = mapErrorToEnvelope(
      new PersistenceError("idempotency_conflict", "SELECT secrets FROM /var/private.db"),
      TRACE_ID,
    );
    expect(mapped.code).toBe("invalid_message");
    expect(mapped.status).toBe(409);
    expect(mapped.message).not.toContain("SELECT");
    expect(mapped.message).not.toContain("/var/private.db");
  });

  it("not_migrated/unavailable → not_ready 且可重试", () => {
    for (const code of ["not_migrated", "unavailable", "closed"] as const) {
      const mapped = mapErrorToEnvelope(new PersistenceError(code, "x"), TRACE_ID);
      expect(mapped.code).toBe("not_ready");
      expect(mapped.status).toBe(503);
      expect(mapped.retryable).toBe(true);
    }
  });

  it("未知错误折叠为 internal_error，不泄露原始信息", () => {
    const mapped = mapErrorToEnvelope(new Error("EACCES /Users/secret/key.pem"), TRACE_ID);
    expect(mapped.code).toBe("internal_error");
    expect(mapped.message).toBe("internal runtime error");
    expect(mapped.message).not.toContain("/Users");
  });
});

describe("stableRequestFingerprint", () => {
  it("bigint 水位参与指纹且不抛异常", () => {
    expect(() => stableRequestFingerprint([{ watermark: 123n }])).not.toThrow();
    expect(stableRequestFingerprint([{ watermark: 123n }])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("相同输入同指纹，不同输入不同指纹", () => {
    const a = stableRequestFingerprint(["s1", "k1", [{ source: "asr", watermark: 100n }]]);
    const b = stableRequestFingerprint(["s1", "k1", [{ source: "asr", watermark: 100n }]]);
    const c = stableRequestFingerprint(["s1", "k1", [{ source: "asr", watermark: 101n }]]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("credential scrubbing through the runtime logger (Gate 3 重开评审修复 1)", () => {
  it("mapErrorToEnvelope 的本地诊断日志不泄露消息中嵌入的凭证", async () => {
    const { createPinoLogger } = await import("@bellis/observability");
    const lines: string[] = [];
    const logger = createPinoLogger({
      service: "bellis-runtime",
      version: "0.1.0-test",
      level: "info",
      destination: { write: (line) => lines.push(line) },
    });
    const canary = "CANARY_0d4c8b2e6f1a9355";
    // Runtime 多处把任意 error.message 写入普通 error 字段；凭证一旦被
    // 异常消息嵌入（如回显 Authorization 头），必须由日志管道内容级脱敏。
    const mapped = mapErrorToEnvelope(
      new Error(`upgrade rejected: Authorization: Bearer ${canary}`),
      TRACE_ID,
      logger,
    );
    expect(mapped.code).toBe("internal_error");
    const text = lines.join("\n");
    expect(text).not.toContain(canary);
    expect(text).toContain("[redacted]");
  });
});
