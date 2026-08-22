import { describe, expect, it } from "vitest";
import {
  ActionFrameSchema,
  ClientControlEnvelopeSchema,
  ControlEnvelopeSchema,
  DecisionPacketSchema,
  GameIntentSchema,
  ServerControlEnvelopeSchema,
  SignalSchema,
} from "../src/index.js";
import { CONTRACT_SCHEMA_ENTRIES } from "../src/json-schema.js";
import {
  BIGINT_PAYLOAD,
  MAX_U64,
  MESSAGE_ID,
  SCHEMA_FIXTURES,
  SESSION_ID,
  TRACE_ID,
  gameIntent as gameIntentFixture,
} from "./fixtures.js";

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
      expect(result.success, `${key} should reject: ${String(sample)}`).toBe(false);
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
    const action = packet.action;
    if ("noOp" in action) {
      throw new Error("expected a speech action variant");
    }
    expect(action.speech?.text).toBe("我看看现在的任务进度");
  });

  it("top-level legacy message/speech keys are structurally rejected", () => {
    // 顶层闭合（strictObject）：ADR 0001 否决的遗留顶层 message/speech
    // 与一切未知顶层键在 Schema 层被拒绝，不存在第二个发言字段，
    // 不依赖下游「约定不读取」。
    const base = {
      schemaVersion: 1,
      cycleId: "33333333-3333-4333-8333-333333333333",
      toolCalls: [],
      action: { schemaVersion: 1, sync: { schemaVersion: 1, hardLanes: [] }, noOp: true },
      next: "finish",
    };
    expect(DecisionPacketSchema.safeParse(base).success).toBe(true);
    expect(DecisionPacketSchema.safeParse({ ...base, message: "伪造的顶层发言" }).success).toBe(
      false,
    );
    expect(
      DecisionPacketSchema.safeParse({ ...base, speech: { text: "另一个顶层发言" } }).success,
    ).toBe(false);
    expect(
      DecisionPacketSchema.safeParse({ ...base, providerMeta: "任何未知顶层键" }).success,
    ).toBe(false);
  });
});

describe("ActionFrame 行动约束（结构化，无跨字段 refine）", () => {
  const sync = { schemaVersion: 1, hardLanes: [] };

  it("rejects a frame without any action or noOp", () => {
    expect(ActionFrameSchema.safeParse({ schemaVersion: 1, sync }).success).toBe(false);
  });

  it("rejects empty action arrays — they are not actions", () => {
    expect(ActionFrameSchema.safeParse({ schemaVersion: 1, sync, avatar: [] }).success).toBe(false);
    expect(ActionFrameSchema.safeParse({ schemaVersion: 1, sync, game: [] }).success).toBe(false);
    expect(ActionFrameSchema.safeParse({ schemaVersion: 1, sync, overlay: [] }).success).toBe(
      false,
    );
  });

  it("noOp is mutually exclusive with real actions", () => {
    const avatarIntent = {
      schemaVersion: 1,
      intentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      motion: "nod_agree",
      channels: ["head"],
      priority: 80,
      durationMs: 100,
      interruptible: true,
      exclusive: false,
      mutexTags: [],
    };
    expect(
      ActionFrameSchema.safeParse({ schemaVersion: 1, sync, noOp: true, avatar: [avatarIntent] })
        .success,
    ).toBe(false);
  });
});

describe("GameIntent at_speech_word 判别约束", () => {
  it("requires wordIndex only for at_speech_word", () => {
    const {
      intentId,
      skillId,
      arguments: args,
    } = gameIntentFixture as {
      intentId: string;
      skillId: string;
      arguments: Record<string, unknown>;
    };
    expect(
      GameIntentSchema.safeParse({
        schemaVersion: 1,
        intentId,
        skillId,
        timeRelation: "at_scene_start",
        arguments: args,
      }).success,
    ).toBe(true);
    expect(
      GameIntentSchema.safeParse({
        schemaVersion: 1,
        intentId,
        skillId,
        timeRelation: "at_speech_word",
        arguments: args,
      }).success,
    ).toBe(false);
    expect(
      GameIntentSchema.safeParse({
        schemaVersion: 1,
        intentId,
        skillId,
        timeRelation: "at_speech_word",
        wordIndex: 2,
        arguments: args,
      }).success,
    ).toBe(true);
  });
});

describe("JSON-safe 开放字段（JsonValueSchema）", () => {
  it("envelope rejects payloads that cannot be JSON serialized", () => {
    const envelope = {
      version: 1,
      type: "clock.ping",
      messageId: MESSAGE_ID,
      sessionId: SESSION_ID,
      trace: { traceId: TRACE_ID },
      sentAtUs: "1",
      payload: BIGINT_PAYLOAD,
      direction: "client",
    };
    expect(ServerControlEnvelopeSchema.safeParse(envelope).success).toBe(false);
    expect(() => JSON.stringify(envelope)).toThrow(TypeError);
  });

  it("signal rejects non-JSON payload values", () => {
    expect(
      SignalSchema.safeParse({
        schemaVersion: 1,
        id: "66666666-6666-4666-8666-666666666666",
        kind: "danmaku",
        source: "test",
        occurredAt: 0,
        priority: 0,
        payload: BIGINT_PAYLOAD,
      }).success,
    ).toBe(false);
  });

  it("valid object fixtures parse to JSON-serializable output", () => {
    // 含 catch-all 扩展键在内：校验通过 ⇔ JSON.stringify 不抛错。
    for (const [key, fixtures] of Object.entries(SCHEMA_FIXTURES)) {
      const schema = CONTRACT_SCHEMA_ENTRIES[key as keyof typeof CONTRACT_SCHEMA_ENTRIES];
      for (const sample of fixtures.valid) {
        if (typeof sample !== "object" || sample === null || Array.isArray(sample)) continue;
        const parsed = schema.parse(sample);
        expect(() => JSON.stringify(parsed), `${key} must stay JSON-serializable`).not.toThrow();
      }
    }
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

  it("server seq starts at 1: zero and leading-zero forms are rejected (Gate 3 重开评审)", () => {
    for (const seq of ["0", "00", "01"]) {
      expect(
        ServerControlEnvelopeSchema.safeParse(envelopeBase({ direction: "server", seq })).success,
      ).toBe(false);
    }
    expect(
      ServerControlEnvelopeSchema.safeParse(envelopeBase({ direction: "server", seq: "1" }))
        .success,
    ).toBe(true);
    // 客户端 ack 仍允许 "0"（累计确认初始态，与服务端 Seq 起点无关）。
    expect(
      ClientControlEnvelopeSchema.safeParse(envelopeBase({ direction: "client", ack: "0" }))
        .success,
    ).toBe(true);
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

  it("envelope is closed: unknown envelope-level keys are rejected", () => {
    expect(
      ServerControlEnvelopeSchema.safeParse(
        envelopeBase({ direction: "server", seq: "5", "x-extra": 1 }),
      ).success,
    ).toBe(false);
    expect(
      ClientControlEnvelopeSchema.safeParse(envelopeBase({ direction: "client", "x-extra": 1 }))
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
