import { describe, expect, it } from "vitest";
import {
  PERSISTENCE_OPERATIONS,
  decodeOperationPayload,
  decodeOperationResult,
  encodeOperationPayload,
  encodeOperationResult,
  isPersistenceOperation,
} from "../../src/rpc/operations.js";
import { PersistenceError } from "../../src/errors.js";
import {
  CYCLE_ID,
  OUTBOX_ID,
  SCENE_ID,
  SESSION_ID,
  TRACE,
  makeOutboxMessage,
  makeScene,
} from "../helpers.js";

/** RPC 编解码单元测试（docs/protocols/persistence-and-recovery.md）。 */

describe("operation 集合", () => {
  it("闭合集合：已知操作被识别，任意方法名被拒绝", () => {
    expect(PERSISTENCE_OPERATIONS).toContain("commit_scene");
    expect(isPersistenceOperation("commit_scene")).toBe(true);
    expect(isPersistenceOperation("DROP TABLE users")).toBe(false);
    expect(isPersistenceOperation("execute_sql")).toBe(false);
    expect(isPersistenceOperation("__proto__")).toBe(false);
  });
});

describe("commit_scene 编解码", () => {
  const watermark = 9007199254740993n;

  function roundtrip() {
    const encoded = encodeOperationPayload({
      operation: "commit_scene",
      input: {
        sceneId: SCENE_ID,
        cycleId: CYCLE_ID,
        sessionId: SESSION_ID,
        scene: makeScene(),
        idempotencyKey: "key-1",
        requestFingerprint: "fp-1",
        watermarks: [{ source: "asr", watermark }],
        outbox: [makeOutboxMessage()],
      },
    });
    const decoded = decodeOperationPayload("commit_scene", encoded);
    return { encoded, decoded };
  }

  it("bigint 水位以规范十进制字符串过线并无损往返", () => {
    const { encoded, decoded } = roundtrip();
    expect((encoded.watermarks as Array<{ watermark: string }>)[0]?.watermark).toBe(
      "9007199254740993",
    );
    if (decoded.operation !== "commit_scene") {
      throw new Error("unexpected operation");
    }
    expect(decoded.input.watermarks[0]?.watermark).toBe(9007199254740993n);
  });

  it("Scene 与 Outbox 在解码时再次通过 Schema 校验", () => {
    const { decoded } = roundtrip();
    if (decoded.operation !== "commit_scene") {
      throw new Error("unexpected operation");
    }
    expect(decoded.input.scene.groups.length).toBe(1);
    expect(decoded.input.outbox[0]?.outboxId).toBe(OUTBOX_ID);
  });

  it("非法 Scene 在 Worker 侧解码即被拒绝（不执行 SQL）", () => {
    const encoded = encodeOperationPayload({
      operation: "commit_scene",
      input: {
        sceneId: SCENE_ID,
        cycleId: CYCLE_ID,
        sessionId: SESSION_ID,
        scene: { ...makeScene(), deadlineMs: -1 },
        idempotencyKey: "key-1",
        requestFingerprint: "fp-1",
        watermarks: [],
        outbox: [],
      },
    });
    expect(() => decodeOperationPayload("commit_scene", encoded)).toThrow(PersistenceError);
    try {
      decodeOperationPayload("commit_scene", encoded);
    } catch (error) {
      expect((error as PersistenceError).code).toBe("invalid_request");
    }
  });

  it("结果编解码：duplicate 标志与 committedAtMs 往返", () => {
    const encoded = encodeOperationResult({
      operation: "commit_scene",
      result: { sceneId: SCENE_ID, committedAtMs: 42, duplicate: true },
    });
    const decoded = decodeOperationResult("commit_scene", encoded);
    expect(decoded.result).toEqual({
      sceneId: SCENE_ID,
      committedAtMs: 42,
      duplicate: true,
    });
  });
});

describe("advance_server_seq 编解码", () => {
  it("结果只含 latestServerSeq；30 位大整数无损", () => {
    const big = 10n ** 29n;
    const encoded = encodeOperationResult({
      operation: "advance_server_seq",
      result: { latestServerSeq: big },
    });
    expect(encoded.latestServerSeq).toBe(big.toString(10));
    const decoded = decodeOperationResult("advance_server_seq", encoded);
    if (decoded.operation !== "advance_server_seq") {
      throw new Error("unexpected operation");
    }
    expect(decoded.result.latestServerSeq).toBe(big);
  });
});

describe("read_recovery_state 编解码", () => {
  it("lastCommittedScene 可为 null", () => {
    const decoded = decodeOperationResult(
      "read_recovery_state",
      encodeOperationResult({
        operation: "read_recovery_state",
        result: {
          sessionId: SESSION_ID,
          latestServerSeq: 5n,
          signalWatermarks: [],
          lastCommittedScene: null,
        },
      }),
    );
    if (decoded.operation !== "read_recovery_state") {
      throw new Error("unexpected operation");
    }
    expect(decoded.result.lastCommittedScene).toBeNull();
  });

  it("畸形结果在 Client 侧折叠为 internal，不盲转", () => {
    expect(() => decodeOperationResult("read_recovery_state", { nonsense: true })).toThrow(
      PersistenceError,
    );
  });
});

describe("简单操作编解码", () => {
  it("void 输入操作编码为空对象", () => {
    expect(encodeOperationPayload({ operation: "ping", input: undefined })).toEqual({});
    expect(encodeOperationPayload({ operation: "migrate", input: undefined })).toEqual({});
  });

  it("claim_outbox 解码校验 limit/leaseMs 边界", () => {
    expect(() =>
      decodeOperationPayload("claim_outbox", { limit: 0, leaseMs: 1000, ownerInstanceId: "a" }),
    ).toThrow(/invalid_request|validation/i);
    expect(
      () =>
        decodeOperationPayload("claim_outbox", { limit: 1, leaseMs: 1000, ownerInstanceId: "a" })
          .input,
    ).toBeDefined();
  });

  it("migrate 结果携带启动恢复的 requeuedInFlight", () => {
    const decoded = decodeOperationResult(
      "migrate",
      encodeOperationResult({ operation: "migrate", result: { requeuedInFlight: 3 } }),
    );
    if (decoded.operation !== "migrate") {
      throw new Error("unexpected operation");
    }
    expect(decoded.result.requeuedInFlight).toBe(3);
  });
});

describe("trace 约定", () => {
  it("trace 不进入 payload（随 Envelope 传播）", () => {
    const encoded = encodeOperationPayload({
      operation: "read_recovery_state",
      input: { sessionId: SESSION_ID },
    });
    expect(Object.keys(encoded)).toEqual(["sessionId"]);
    expect(TRACE.traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});
