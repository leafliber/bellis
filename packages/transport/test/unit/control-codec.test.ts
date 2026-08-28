import { describe, expect, it } from "vitest";
import { CLIENT_TO_SERVER_MESSAGE_TYPES } from "@bellis/contracts";
import {
  DEFAULT_MAX_CONTROL_TEXT_BYTES,
  TransportProtocolViolationError,
  decodeControlMessage,
  encodeControlMessage,
} from "../../src/index.js";
import { MESSAGE_ID, SESSION_ID, VALID_PAYLOADS, clientText, serverText } from "../helpers.js";

describe("decodeControlMessage", () => {
  it("接受全部合法客户端消息类型", () => {
    for (const type of [
      "client.hello",
      "heartbeat.ping",
      "clock.ping",
      "media.stream.open",
      "media.stream.closed",
    ]) {
      const result = decodeControlMessage(clientText({ type }));
      expect(result.ok, type).toBe(true);
      if (result.ok) {
        expect(result.value.type).toBe(type);
        expect(result.value.direction).toBe("client");
      }
    }
  });

  it("接受全部合法服务端消息类型（含双向类型）", () => {
    for (const type of [
      "server.hello",
      "server.ready",
      "heartbeat.pong",
      "clock.pong",
      "session.snapshot",
      "scene.prepared",
      "scene.committed",
      "scene.cancelled",
      "media.stream.closed",
      "error",
    ]) {
      const result = decodeControlMessage(serverText({ type }));
      expect(result.ok, type).toBe(true);
    }
  });

  it("接受全部 Phase 2 客户端 → 服务端演出消息（stage → runtime）", () => {
    for (const type of [
      "stage.capabilities",
      "scene.ready",
      "scene.started",
      "scene.finished",
      "scene.cancel.ack",
      "media.stream.ready",
    ]) {
      const result = decodeControlMessage(clientText({ type }));
      expect(result.ok, type).toBe(true);
      if (result.ok) {
        expect(result.value.type).toBe(type);
      }
    }
  });

  it("接受全部 Phase 2 服务端 → 客户端演出消息（runtime → stage）", () => {
    for (const type of ["scene.prepare", "scene.commit", "scene.cancel", "media.stream.announce"]) {
      const result = decodeControlMessage(serverText({ type }));
      expect(result.ok, type).toBe(true);
    }
  });

  it("Phase 2 命令与回执方向不可互换（scene.commit 走客户端方向被拒绝）", () => {
    const result = decodeControlMessage(clientText({ type: "scene.commit" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain("not allowed in client direction");
    }
  });

  it("Phase 2 命令与回执方向不可互换（scene.ready 走服务端方向被拒绝）", () => {
    const result = decodeControlMessage(serverText({ type: "scene.ready" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain("not allowed in server direction");
    }
  });

  it("拒绝非字符串输入", () => {
    for (const input of [null, 42, {}, new Uint8Array(4), true]) {
      const result = decodeControlMessage(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.code).toBe("invalid_message");
      }
    }
  });

  it("拒绝超过大小限制的文本", () => {
    const huge = clientText() + " ".repeat(DEFAULT_MAX_CONTROL_TEXT_BYTES);
    const result = decodeControlMessage(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("invalid_message");
      expect(result.failure.message).toContain("size limit");
    }
  });

  it("尊重自定义大小限制（字节而非字符数）", () => {
    const base = clientText();
    const result = decodeControlMessage(base, { maxTextBytes: Buffer.byteLength(base) - 1 });
    expect(result.ok).toBe(false);
  });

  it("拒绝非法 JSON", () => {
    const result = decodeControlMessage("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("invalid_message");
      expect(result.failure.message).toContain("JSON");
    }
  });

  it("数值 version ≠ 1 分类为 unsupported_version", () => {
    const raw = JSON.stringify({
      version: 2,
      direction: "client",
      type: "heartbeat.ping",
      messageId: MESSAGE_ID,
      sessionId: SESSION_ID,
      trace: { traceId: "0123456789abcdef0123456789abcdef" },
      sentAtUs: "1",
      payload: {},
    });
    const result = decodeControlMessage(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("unsupported_version");
    }
  });

  it("拒绝未知 type", () => {
    const result = decodeControlMessage(clientText({ type: "totally.unknown.type" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain("unknown message type");
    }
  });

  it("拒绝方向违例（客户端类型走服务端方向）", () => {
    const result = decodeControlMessage(serverText({ type: "heartbeat.ping" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain("not allowed in server direction");
    }
  });

  it("拒绝方向违例（服务端类型走客户端方向）", () => {
    const result = decodeControlMessage(clientText({ type: "scene.committed" }));
    expect(result.ok).toBe(false);
  });

  it("拒绝 Payload Schema 不匹配（server.hello 缺 runtimeVersion）", () => {
    const result = decodeControlMessage(
      serverText({
        type: "server.hello",
        payload: { protocolVersion: 1, heartbeatIntervalMs: 1000, replayWindowSize: 8 },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain("payload does not match schema");
    }
  });

  it("拒绝 31 位十进制字符串（超过上限）", () => {
    const result = decodeControlMessage(
      serverText({ type: "server.ready" }, { seq: "1".repeat(31) }),
    );
    expect(result.ok).toBe(false);
  });

  it("拒绝未知 Envelope 字段（strict 对象）", () => {
    const raw = JSON.stringify({
      version: 1,
      direction: "client",
      type: "heartbeat.ping",
      messageId: MESSAGE_ID,
      sessionId: SESSION_ID,
      trace: { traceId: "0123456789abcdef0123456789abcdef" },
      sentAtUs: "1",
      payload: {},
      seq: "1",
    });
    const result = decodeControlMessage(raw);
    expect(result.ok).toBe(false);
  });

  it("失败信息不包含原始 Payload 内容", () => {
    const raw = clientText({ type: "clock.ping", payload: { c0: "SECRET-VALUE" } as never });
    const result = decodeControlMessage(`{${raw.slice(1, -1)},extra}`);
    if (!result.ok) {
      expect(result.failure.message).not.toContain("SECRET-VALUE");
    }
  });
});

describe("encodeControlMessage", () => {
  it("合法 Envelope 编码后可无损解码回来", () => {
    for (const [type, payload] of Object.entries(VALID_PAYLOADS)) {
      // 方向判定直接来自 Contracts 方向表（避免测试内复制白名单）。
      const isServerType = !(CLIENT_TO_SERVER_MESSAGE_TYPES as readonly string[]).includes(type);
      const text = isServerType ? serverText({ type, payload }) : clientText({ type, payload });
      const encoded = encodeControlMessage(JSON.parse(text));
      const decoded = decodeControlMessage(encoded);
      expect(decoded.ok, type).toBe(true);
      if (decoded.ok) {
        expect(decoded.value).toEqual(JSON.parse(text));
      }
    }
  });

  it("对非法 Envelope 抛 TransportProtocolViolationError", () => {
    const bad = JSON.parse(clientText({ type: "no.such.type" }));
    expect(() => encodeControlMessage(bad)).toThrow(TransportProtocolViolationError);
    const badPayload = JSON.parse(serverText({ type: "server.hello", payload: {} }));
    expect(() => encodeControlMessage(badPayload)).toThrow(TransportProtocolViolationError);
  });

  it("拒绝把裸 bigint 塞进 Envelope（JSON 不可序列化）", () => {
    const raw = JSON.parse(clientText());
    (raw as { sentAtUs: unknown }).sentAtUs = 123n;
    expect(() => encodeControlMessage(raw)).toThrow();
  });
});
