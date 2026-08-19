import { describe, expect, it } from "vitest";
import {
  ClientControlEnvelopeSchema,
  ControlEnvelopeSchema,
  DecisionPacketSchema,
  ServerControlEnvelopeSchema,
} from "../src/index.js";
import { CONTRACT_SCHEMA_ENTRIES } from "../src/json-schema.js";
import { MAX_U64, MESSAGE_ID, SCHEMA_FIXTURES, SESSION_ID, TRACE_ID } from "./fixtures.js";

/**
 * 契约测试：每个公开 Schema 至少具备成功样例与失败样例（phase-1-build-guide.md §6.1），
 * 并验证关键的协议不变量。
 */
describe("schema fixtures", () => {
  it("every public schema has valid and invalid fixtures", () => {
    for (const [key, fixtures] of Object.entries(SCHEMA_FIXTURES)) {
      expect(fixtures.valid.length, `${key} needs at least one valid fixture`).toBeGreaterThan(0);
      expect(fixtures.invalid.length, `${key} needs at least one invalid fixture`).toBeGreaterThan(
        0,
      );
    }
  });

  it("fixture registry covers every generated schema key", () => {
    expect(Object.keys(SCHEMA_FIXTURES).toSorted()).toEqual(
      Object.keys(CONTRACT_SCHEMA_ENTRIES).toSorted(),
    );
  });

  it.each(Object.entries(SCHEMA_FIXTURES))("%s: valid fixtures parse", (key, fixtures) => {
    const schema = CONTRACT_SCHEMA_ENTRIES[key as keyof typeof CONTRACT_SCHEMA_ENTRIES];
    for (const sample of fixtures.valid) {
      const result = schema.safeParse(sample);
      expect(result.success, `${key} should accept: ${JSON.stringify(sample)}`).toBe(true);
    }
  });

  it.each(Object.entries(SCHEMA_FIXTURES))("%s: invalid fixtures are rejected", (key, fixtures) => {
    const schema = CONTRACT_SCHEMA_ENTRIES[key as keyof typeof CONTRACT_SCHEMA_ENTRIES];
    for (const sample of fixtures.invalid) {
      const result = schema.safeParse(sample);
      expect(result.success, `${key} should reject: ${JSON.stringify(sample)}`).toBe(false);
    }
  });

  it.each(
    Object.entries(SCHEMA_FIXTURES).filter(([, fixtures]) => fixtures.refinementOnly !== undefined),
  )("%s: refinement-only fixtures are rejected by Zod", (key, fixtures) => {
    const schema = CONTRACT_SCHEMA_ENTRIES[key as keyof typeof CONTRACT_SCHEMA_ENTRIES];
    for (const sample of fixtures.refinementOnly ?? []) {
      const result = schema.safeParse(sample);
      expect(result.success, `${key} refinement should reject: ${JSON.stringify(sample)}`).toBe(
        false,
      );
    }
  });
});

describe("DecisionPacket 单一发言来源（ADR 0001）", () => {
  it("speech exists only inside action, never top-level", () => {
    const packet = DecisionPacketSchema.parse({
      schemaVersion: 1,
      cycleId: "33333333-3333-4333-8333-333333333333",
      toolCalls: [],
      action: {
        schemaVersion: 1,
        speech: {
          schemaVersion: 1,
          text: "我看看现在的任务进度",
          purpose: "tool_notice",
          interruptible: true,
        },
        sync: { schemaVersion: 1, hardLanes: ["audio"] },
      },
      next: "after_tools",
    });
    expect(packet.action.speech?.text).toBe("我看看现在的任务进度");
    expect("speech" in packet && packet.speech !== undefined).toBe(false);
    expect("message" in packet).toBe(false);
  });

  it("top-level message or speech fields are stripped, not trusted", () => {
    const parsed = DecisionPacketSchema.parse({
      schemaVersion: 1,
      cycleId: "33333333-3333-4333-8333-333333333333",
      message: "伪造的顶层发言",
      speech: { text: "另一个顶层发言" },
      toolCalls: [],
      action: { schemaVersion: 1, sync: { schemaVersion: 1, hardLanes: [] }, noOp: true },
      next: "finish",
    });
    expect("message" in parsed).toBe(false);
    expect("speech" in parsed).toBe(false);
  });
});

function envelopeBase(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 1,
    type: "clock.ping",
    messageId: MESSAGE_ID,
    sessionId: SESSION_ID,
    trace: { traceId: TRACE_ID },
    sentAtUs: "1000",
    payload: {},
    ...overrides,
  };
}

describe("Control Envelope 方向判别（ADR 0001）", () => {
  it("server envelope requires seq and rejects client-only fields", () => {
    expect(
      ServerControlEnvelopeSchema.safeParse(envelopeBase({ direction: "server", seq: "5" }))
        .success,
    ).toBe(true);
    expect(
      ServerControlEnvelopeSchema.safeParse(envelopeBase({ direction: "server" })).success,
    ).toBe(false);
    expect(
      ServerControlEnvelopeSchema.safeParse(
        envelopeBase({ direction: "server", seq: "5", ack: "1" }),
      ).success,
    ).toBe(false);
    expect(
      ServerControlEnvelopeSchema.safeParse(
        envelopeBase({ direction: "server", seq: "5", idempotencyKey: "k" }),
      ).success,
    ).toBe(false);
  });

  it("client envelope may ack/idempotency but must not forge seq", () => {
    expect(
      ClientControlEnvelopeSchema.safeParse(envelopeBase({ direction: "client" })).success,
    ).toBe(true);
    expect(
      ClientControlEnvelopeSchema.safeParse(
        envelopeBase({ direction: "client", ack: MAX_U64, idempotencyKey: "scene-1" }),
      ).success,
    ).toBe(true);
    expect(
      ClientControlEnvelopeSchema.safeParse(envelopeBase({ direction: "client", seq: "0" }))
        .success,
    ).toBe(false);
  });

  it("union dispatches on direction", () => {
    expect(
      ControlEnvelopeSchema.safeParse(envelopeBase({ direction: "server", seq: "1" })).success,
    ).toBe(true);
    expect(ControlEnvelopeSchema.safeParse(envelopeBase({ direction: "client" })).success).toBe(
      true,
    );
    expect(ControlEnvelopeSchema.safeParse(envelopeBase({ direction: "peer" })).success).toBe(
      false,
    );
  });
});
