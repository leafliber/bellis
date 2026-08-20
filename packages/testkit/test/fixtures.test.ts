import { describe, expect, it } from "vitest";
import {
  ClientControlEnvelopeSchema,
  EnvelopeTraceSchema,
  MediaFrameHeaderSchema,
  OutboxMessageSchema,
  SceneSchema,
  ServerControlEnvelopeSchema,
  SessionRecordSchema,
  TraceContextSchema,
} from "@bellis/contracts";
import {
  FIXTURE_SESSION_ID,
  makeClientEnvelope,
  makeEnvelopeTrace,
  makeMediaFrameHeader,
  makeOutboxMessage,
  makeScene,
  makeServerEnvelope,
  makeSessionRecord,
  makeTraceContext,
} from "../src/index.js";

describe("protocol fixtures produce contract-valid objects", () => {
  it("trace context and envelope trace", () => {
    expect(TraceContextSchema.safeParse(makeTraceContext()).success).toBe(true);
    expect(EnvelopeTraceSchema.safeParse(makeEnvelopeTrace()).success).toBe(true);
  });

  it("server and client control envelopes", () => {
    const server = makeServerEnvelope();
    const client = makeClientEnvelope();
    expect(ServerControlEnvelopeSchema.safeParse(server).success).toBe(true);
    expect(ClientControlEnvelopeSchema.safeParse(client).success).toBe(true);
    expect(server.direction).toBe("server");
    expect(client.direction).toBe("client");
  });

  it("media frame header, scene, outbox message and session record", () => {
    expect(MediaFrameHeaderSchema.safeParse(makeMediaFrameHeader()).success).toBe(true);
    expect(SceneSchema.safeParse(makeScene()).success).toBe(true);
    expect(OutboxMessageSchema.safeParse(makeOutboxMessage()).success).toBe(true);
    expect(SessionRecordSchema.safeParse(makeSessionRecord()).success).toBe(true);
  });

  it("fixtures survive a JSON wire round-trip", () => {
    for (const fixture of [
      makeServerEnvelope(),
      makeClientEnvelope(),
      makeMediaFrameHeader(),
      makeScene(),
      makeOutboxMessage(),
      makeSessionRecord(),
    ]) {
      expect(JSON.parse(JSON.stringify(fixture))).toEqual(fixture);
    }
  });
});

describe("fixture independence and overrides", () => {
  it("returns fresh objects with no shared mutable payload", () => {
    const first = makeScene();
    const second = makeScene();
    expect(first).not.toBe(second);
    expect(first.groups).not.toBe(second.groups);
    first.groups[0]?.lanes.push("subtitle" as never);
    first.deadlineMs = 99;
    expect(second.groups[0]?.lanes).toEqual(["audio"]);
    expect(second.deadlineMs).toBe(5_000);
    expect(SceneSchema.safeParse(second).success).toBe(true);

    const envelopeA = makeServerEnvelope();
    const envelopeB = makeServerEnvelope();
    expect(envelopeA.payload).not.toBe(envelopeB.payload);
    expect(envelopeA.trace).not.toBe(envelopeB.trace);
  });

  it("overrides only the requested fields; undefined keeps defaults", () => {
    const envelope = makeServerEnvelope({
      seq: "42",
      sentAtUs: "9000",
      trace: makeEnvelopeTrace({ spanId: undefined as unknown as string }),
    });
    expect(envelope.seq).toBe("42");
    expect(envelope.sentAtUs).toBe("9000");
    expect(envelope.type).toBe("scene.committed");
    expect(envelope.trace.spanId).toBe(makeEnvelopeTrace().spanId);
    expect(ServerControlEnvelopeSchema.safeParse(envelope).success).toBe(true);

    const record = makeSessionRecord({ recordType: "scene_committed", aggregateSeq: "7" });
    expect(record.sessionId).toBe(FIXTURE_SESSION_ID);
    expect(record.recordType).toBe("scene_committed");
    expect(record.aggregateSeq).toBe("7");
  });

  it("supports building invalid variants for negative tests", () => {
    const invalid = makeServerEnvelope({ seq: "-1" });
    expect(ServerControlEnvelopeSchema.safeParse(invalid).success).toBe(false);
    const invalidRecord = makeSessionRecord({ occurredAtMs: -5 });
    expect(SessionRecordSchema.safeParse(invalidRecord).success).toBe(false);
  });

  it("deep-copies override values: shared payloads never alias across fixtures (评审 P2-4)", () => {
    const sharedPayload = { sceneId: "22222222-2222-4222-8222-222222222222", nested: { hop: 1 } };
    const first = makeOutboxMessage({ payload: sharedPayload });
    const second = makeOutboxMessage({ payload: sharedPayload });
    expect(first.payload).not.toBe(sharedPayload);
    expect(first.payload).not.toBe(second.payload);
    (first.payload as Record<string, unknown>).sceneId = "mutated";
    ((first.payload as Record<string, unknown>).nested as Record<string, unknown>).hop = 99;
    expect((second.payload as Record<string, unknown>).sceneId).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(
      ((second.payload as Record<string, unknown>).nested as Record<string, unknown>).hop,
    ).toBe(1);
    // 覆盖传入的原对象也不受影响。
    sharedPayload.sceneId = "mutated-source";
    expect((second.payload as Record<string, unknown>).sceneId).toBe(
      "22222222-2222-4222-8222-222222222222",
    );

    const sharedGroups = makeScene().groups;
    const sceneA = makeScene({ groups: sharedGroups });
    const sceneB = makeScene({ groups: sharedGroups });
    sceneA.groups[0]?.lanes.push("subtitle");
    expect(sceneB.groups[0]?.lanes).toEqual(["audio"]);
    expect(SceneSchema.safeParse(sceneB).success).toBe(true);
  });

  it("preserves legal __proto__ extension keys passed as overrides (评审 P2-4)", () => {
    const overrides = JSON.parse(
      '{"payload":{"a":1},"__proto__":{"ext":true}}',
    ) as unknown as Partial<ReturnType<typeof makeSessionRecord>>;
    const record = makeSessionRecord(overrides);
    expect(Object.hasOwn(record, "__proto__")).toBe(true);
    expect((record as Record<string, unknown>).__proto__).toEqual({ ext: true });
    expect((record.payload as Record<string, unknown>).a).toBe(1);
    expect(SessionRecordSchema.safeParse(record).success).toBe(true);
  });
});
