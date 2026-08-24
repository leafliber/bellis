import { describe, expect, it } from "vitest";
import {
  PersistenceCheckpointNoticeSchema,
  PersistenceRpcRequestSchema,
  PersistenceRpcResponseSchema,
  isCheckpointNotice,
  isCheckpointRelease,
} from "../../src/rpc/envelope.js";
import {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  toSafePersistenceError,
} from "../../src/errors.js";
import { SESSION_ID, TRACE } from "../helpers.js";

/** Envelope 与错误模型单元测试（docs/protocols/persistence-and-recovery.md）。 */

describe("PersistenceRpcRequestSchema", () => {
  it("接受合法请求", () => {
    const parsed = PersistenceRpcRequestSchema.safeParse({
      version: 1,
      requestId: "99999999-9999-4999-8999-999999999999",
      operation: "ping",
      deadlineUs: "1000000",
      trace: TRACE,
      payload: {},
    });
    expect(parsed.success).toBe(true);
  });

  it("拒绝错误 version / requestId / deadlineUs", () => {
    expect(
      PersistenceRpcRequestSchema.safeParse({
        version: 2,
        requestId: "99999999-9999-4999-8999-999999999999",
        operation: "ping",
        trace: TRACE,
        payload: {},
      }).success,
    ).toBe(false);
    expect(
      PersistenceRpcRequestSchema.safeParse({
        version: 1,
        requestId: "not-a-uuid",
        operation: "ping",
        trace: TRACE,
        payload: {},
      }).success,
    ).toBe(false);
    expect(
      PersistenceRpcRequestSchema.safeParse({
        version: 1,
        requestId: "99999999-9999-4999-8999-999999999999",
        operation: "ping",
        deadlineUs: "-5",
        trace: TRACE,
        payload: {},
      }).success,
    ).toBe(false);
  });

  it("trace 必须是合法 TraceContext", () => {
    expect(
      PersistenceRpcRequestSchema.safeParse({
        version: 1,
        requestId: "99999999-9999-4999-8999-999999999999",
        operation: "ping",
        trace: { traceId: "XYZ" },
        payload: {},
      }).success,
    ).toBe(false);
  });
});

describe("PersistenceRpcResponseSchema", () => {
  it("错误码是闭合集合：未知 code 被拒绝", () => {
    expect(
      PersistenceRpcResponseSchema.safeParse({
        version: 1,
        requestId: "99999999-9999-4999-8999-999999999999",
        ok: false,
        error: { code: "SQLITE_ERROR: near ...", message: "x", retryable: false },
      }).success,
    ).toBe(false);
  });

  it("安全错误消息长度有界", () => {
    expect(
      PersistenceRpcResponseSchema.safeParse({
        version: 1,
        requestId: "99999999-9999-4999-8999-999999999999",
        ok: false,
        error: { code: "internal", message: "x".repeat(600), retryable: false },
      }).success,
    ).toBe(false);
  });
});

describe("检查点消息", () => {
  it("notice / release 判定", () => {
    expect(
      isCheckpointNotice({
        type: "persistence_checkpoint",
        version: 1,
        requestId: "99999999-9999-4999-8999-999999999999",
        checkpoint: "before_scene_transaction_commit",
        context: { traceId: TRACE.traceId, sceneId: SESSION_ID },
      }),
    ).toBe(true);
    expect(isCheckpointNotice({ type: "persistence_checkpoint_release", version: 1 })).toBe(false);
    expect(
      isCheckpointRelease({
        type: "persistence_checkpoint_release",
        version: 1,
        requestId: "99999999-9999-4999-8999-999999999999",
        proceed: true,
      }),
    ).toBe(true);
    expect(isCheckpointRelease({ type: "persistence_checkpoint", version: 1 })).toBe(false);
  });

  it("未知检查点名被拒绝", () => {
    expect(
      PersistenceCheckpointNoticeSchema.safeParse({
        type: "persistence_checkpoint",
        version: 1,
        requestId: "99999999-9999-4999-8999-999999999999",
        checkpoint: "before_drop_table",
        context: { traceId: TRACE.traceId },
      }).success,
    ).toBe(false);
  });
});

describe("错误模型", () => {
  it("安全错误不包含 cause/SQL/路径", () => {
    const error = new PersistenceError("internal", "boom", {
      cause: new Error("SELECT * FROM sessions; /var/lib/state.db"),
    });
    expect(JSON.stringify(error.safe)).not.toContain("SELECT");
    expect(JSON.stringify(error.safe)).not.toContain("/var/lib");
  });

  it("未知异常折叠为 internal 安全错误", () => {
    const safe = toSafePersistenceError(new Error("SQLITE_BUSY database is locked at /x/y"));
    expect(safe.code).toBe("internal");
    expect(safe.retryable).toBe(false);
  });

  it("默认可重试码：unavailable / deadline_exceeded / database_busy", () => {
    for (const code of PERSISTENCE_ERROR_CODES) {
      const error = new PersistenceError(code, "m");
      const expected =
        code === "unavailable" || code === "deadline_exceeded" || code === "database_busy";
      expect(error.retryable).toBe(expected);
    }
  });
});
