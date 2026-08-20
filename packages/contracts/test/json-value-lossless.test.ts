import { describe, expect, it } from "vitest";
import { JsonValueSchema, extensibleJsonRecord, type JsonValue } from "../src/common/json-value.js";
import { ControlPayloadSchema } from "../src/transport/control-payload.js";
import { ServerControlEnvelopeSchema } from "../src/transport/control-envelope.js";
import { SessionRecordSchema } from "../src/session/session-record.js";
import { ToolCallSchema } from "../src/decision/tool-call.js";
import { GameIntentSchema } from "../src/decision/intents.js";
import { MESSAGE_ID, SESSION_ID, TRACE_ID, TOOL_RUN_ID } from "./fixtures.js";

/**
 * 危险键无损保留回归（评审复现：input {"__proto__":null} → output {}）。
 *
 * JSON 允许 "__proto__" 作为普通键名；JSON.parse 生成自有数据属性，
 * JSON.stringify 如实输出。Zod 4 的 z.record / z.object 重建输出时会
 * 静默跳过该键（防原型污染），导致合法 payload 在 parse 后丢字段、
 * 且与 Ajv 生成的 JSON Schema 判定不一致。这些用例固定转义/还原行为：
 * parse 输出与输入 JSON 文本逐字节等价（含键序）。
 */

/** 危险键只能经 JSON.parse / defineProperty 构造：对象字面量 {__proto__: x} 走原型 setter。 */
function parseJson(text: string): unknown {
  return JSON.parse(text);
}

describe("JsonValueSchema 危险键无损", () => {
  it('评审精确复现：{"__proto__":null} 原样保留', () => {
    const input = parseJson('{"__proto__":null}') as JsonValue;
    const output = JsonValueSchema.parse(input);
    expect(JSON.stringify(output)).toBe('{"__proto__":null}');
    expect(Object.hasOwn(output as object, "__proto__")).toBe(true);
  });

  it("嵌套对象、数组元素与 __proto__ 值内部全部保留，键序不变", () => {
    const text =
      '{"__proto__":null,"b":1,"nested":{"__proto__":{"__proto__":true}},"arr":[{"__proto__":"x"},2],"\\u0000own":3,"\\u0000\\u0000deep":4}';
    const input = parseJson(text) as JsonValue;
    const output = JsonValueSchema.parse(input);
    expect(JSON.stringify(output)).toBe(text);
  });

  it("safeParse 成功时 data 同样无损", () => {
    const result = JsonValueSchema.safeParse(parseJson('{"__proto__":{"k":[1]}}'));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(JSON.stringify(result.data)).toBe('{"__proto__":{"k":[1]}}');
    }
  });

  it("危险键携带非 JSON 值仍然被拒绝（转义不放宽校验）", () => {
    const dangerous: Record<string, unknown> = { ok: 1 };
    Object.defineProperty(dangerous, "__proto__", {
      value: 9007199254740993n,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(JsonValueSchema.safeParse(dangerous).success).toBe(false);
  });

  it("可枚举 Symbol 键仍被拒绝（转义拷贝不放宽非字符串键语义）", () => {
    // 危险键触发转义拷贝路径：Symbol 键必须随拷贝保留，才能被 z.record 拒绝。
    const withSymbol: Record<string, unknown> = { ok: 1 };
    Object.defineProperty(withSymbol, "__proto__", {
      value: null,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(withSymbol, Symbol("s"), {
      value: 1,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(JsonValueSchema.safeParse(withSymbol).success).toBe(false);
  });

  it("无危险键时 parse 语义与修复前一致", () => {
    const clean = parseJson('{"a":{"b":[1,null,true,"x"]},"c":{}}') as JsonValue;
    expect(JSON.stringify(JsonValueSchema.parse(clean))).toBe(JSON.stringify(clean));
  });
});

describe("可扩展对象危险扩展键无损", () => {
  it("SessionRecord 未知扩展键 __proto__ 经 parse 保留", () => {
    const record = parseJson(`{
      "schemaVersion": 1,
      "recordId": "${MESSAGE_ID}",
      "sessionId": "${SESSION_ID}",
      "recordType": "load.record",
      "traceId": "${TRACE_ID}",
      "occurredAtMs": 0,
      "payload": {"__proto__":null},
      "__proto__": {"ext": true}
    }`);
    const parsed = SessionRecordSchema.parse(record);
    expect(JSON.stringify(parsed.payload)).toBe('{"__proto__":null}');
    // extensibleJsonObject 自身层的危险扩展键同样保留。
    const output = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
    expect(Object.hasOwn(output, "__proto__")).toBe(true);
    expect(output.__proto__).toEqual({ ext: true });
  });

  it("ControlPayloadSchema 判别联合成员层的危险扩展键保留", () => {
    const message = parseJson(`{
      "type": "clock.ping",
      "payload": {"c0": "1", "__proto__": null},
      "__proto__": {"top": 1}
    }`);
    const parsed = ControlPayloadSchema.parse(message);
    expect(JSON.stringify(parsed.payload)).toBe('{"c0":"1","__proto__":null}');
    const output = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
    expect(Object.hasOwn(output, "__proto__")).toBe(true);
    expect(output.__proto__).toEqual({ top: 1 });
  });

  it("ServerControlEnvelope 全链路：wire 文本往返逐字节等价", () => {
    const wireText = `{
      "version": 1,
      "type": "clock.ping",
      "direction": "server",
      "messageId": "${MESSAGE_ID}",
      "sessionId": "${SESSION_ID}",
      "trace": {"traceId": "${TRACE_ID}"},
      "sentAtUs": "42",
      "seq": "0",
      "payload": {"__proto__":null,"nested":{"__proto__":1}}
    }`;
    const parsed = ServerControlEnvelopeSchema.parse(parseJson(wireText));
    // JSON.stringify 按键序输出；与原文空白无关的部分（trace 键序）构造时已一致。
    expect(JSON.stringify(parsed.payload)).toBe('{"__proto__":null,"nested":{"__proto__":1}}');
  });

  it("ToolCall arguments 的 __proto__ 键名无损保留", () => {
    const call = parseJson(`{
      "schemaVersion": 1,
      "toolRunId": "${TOOL_RUN_ID}",
      "toolName": "stage.light",
      "arguments": {"__proto__": {"level": 80}, "\\u0000zero": 1}
    }`);
    const parsed = ToolCallSchema.parse(call);
    expect(JSON.stringify(parsed.arguments)).toBe('{"__proto__":{"level":80},"\\u0000zero":1}');
  });

  it("extensibleJsonRecord 单独使用同样保留（GameIntent arguments）", () => {
    const intent = parseJson(`{
      "schemaVersion": 1,
      "intentId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "skillId": "stage.light",
      "arguments": {"__proto__": null},
      "timeRelation": "independent"
    }`);
    const parsed = GameIntentSchema.parse(intent);
    expect(JSON.stringify(parsed.arguments)).toBe('{"__proto__":null}');
    expect(extensibleJsonRecord(JsonValueSchema).parse(parseJson('{"__proto__":1}'))).toBeDefined();
  });
});
