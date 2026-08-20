import type {
  ClientControlEnvelope,
  EnvelopeTrace,
  MediaFrameHeader,
  OutboxMessage,
  Scene,
  ServerControlEnvelope,
  SessionRecord,
  TraceContext,
} from "@bellis/contracts";

/**
 * 协议 Fixture 工厂（p3-observability-testkit.md §9.4）。
 *
 * - 默认值全部通过 Contracts Schema；调用方只覆盖所需字段
 *   （显式传入 undefined 的字段保持默认值，不落入结果）；
 * - 每次调用都返回全新的独立对象（含嵌套 payload），不共享可变引用；
 * - 返回类型一律来自 @bellis/contracts，本文件不复制协议类型；
 * - 非法样例由调用方覆盖字段构造（例如 seq: "-1"），本工厂只保证默认合法。
 */

export const FIXTURE_TRACE_ID = "0123456789abcdef0123456789abcdef";
export const FIXTURE_SPAN_ID = "0123456789abcdef";
export const FIXTURE_SESSION_ID = "11111111-1111-4111-8111-111111111111";
export const FIXTURE_SCENE_ID = "22222222-2222-4222-8222-222222222222";
export const FIXTURE_CYCLE_ID = "33333333-3333-4333-8333-333333333333";
export const FIXTURE_GROUP_ID = "44444444-4444-4444-8444-444444444444";
export const FIXTURE_CUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const FIXTURE_MESSAGE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const FIXTURE_OUTBOX_ID = "55555555-5555-4555-8555-555555555555";
export const FIXTURE_RECORD_ID = "66666666-6666-4666-8666-666666666666";
export const FIXTURE_STREAM_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const FIXTURE_FRAME_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function withOverrides<T extends object>(base: T, overrides?: Partial<T>): T {
  if (overrides === undefined) {
    return base;
  }
  const merged = { ...base } as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged as T;
}

export function makeTraceContext(overrides?: Partial<TraceContext>): TraceContext {
  return withOverrides<TraceContext>(
    {
      traceId: FIXTURE_TRACE_ID,
      spanId: FIXTURE_SPAN_ID,
      sessionId: FIXTURE_SESSION_ID,
    },
    overrides,
  );
}

export function makeEnvelopeTrace(overrides?: Partial<EnvelopeTrace>): EnvelopeTrace {
  return withOverrides<EnvelopeTrace>(
    { traceId: FIXTURE_TRACE_ID, spanId: FIXTURE_SPAN_ID },
    overrides,
  );
}

export function makeServerEnvelope(
  overrides?: Partial<ServerControlEnvelope>,
): ServerControlEnvelope {
  return withOverrides<ServerControlEnvelope>(
    {
      version: 1,
      direction: "server",
      type: "scene.committed",
      messageId: FIXTURE_MESSAGE_ID,
      sessionId: FIXTURE_SESSION_ID,
      trace: makeEnvelopeTrace(),
      sentAtUs: "1000",
      seq: "1",
      payload: { sceneId: FIXTURE_SCENE_ID },
    },
    overrides,
  );
}

export function makeClientEnvelope(
  overrides?: Partial<ClientControlEnvelope>,
): ClientControlEnvelope {
  return withOverrides<ClientControlEnvelope>(
    {
      version: 1,
      direction: "client",
      type: "clock.ping",
      messageId: FIXTURE_MESSAGE_ID,
      sessionId: FIXTURE_SESSION_ID,
      trace: makeEnvelopeTrace(),
      sentAtUs: "2000",
      idempotencyKey: "idem-1",
      payload: { nonce: "42" },
    },
    overrides,
  );
}

export function makeMediaFrameHeader(overrides?: Partial<MediaFrameHeader>): MediaFrameHeader {
  return withOverrides<MediaFrameHeader>(
    {
      schemaVersion: 1,
      streamId: FIXTURE_STREAM_ID,
      frameId: FIXTURE_FRAME_ID,
      sessionId: FIXTURE_SESSION_ID,
      sceneId: FIXTURE_SCENE_ID,
      sequence: "0",
      contentType: "audio/opus",
      traceId: FIXTURE_TRACE_ID,
    },
    overrides,
  );
}

export function makeScene(overrides?: Partial<Scene>): Scene {
  return withOverrides<Scene>(
    {
      schemaVersion: 1,
      sceneId: FIXTURE_SCENE_ID,
      cycleId: FIXTURE_CYCLE_ID,
      groups: [
        {
          schemaVersion: 1,
          groupId: FIXTURE_GROUP_ID,
          lanes: ["audio"],
          level: "hard",
        },
      ],
      deadlineMs: 5_000,
      interruptPolicy: "finish",
    },
    overrides,
  );
}

export function makeOutboxMessage(overrides?: Partial<OutboxMessage>): OutboxMessage {
  return withOverrides<OutboxMessage>(
    {
      schemaVersion: 1,
      outboxId: FIXTURE_OUTBOX_ID,
      topic: "scene.committed",
      partitionKey: FIXTURE_SESSION_ID,
      payload: { sceneId: FIXTURE_SCENE_ID },
      createdAtMs: 1,
    },
    overrides,
  );
}

export function makeSessionRecord(overrides?: Partial<SessionRecord>): SessionRecord {
  return withOverrides<SessionRecord>(
    {
      schemaVersion: 1,
      recordId: FIXTURE_RECORD_ID,
      sessionId: FIXTURE_SESSION_ID,
      recordType: "session.opened",
      traceId: FIXTURE_TRACE_ID,
      occurredAtMs: 1,
      payload: { reason: "initial" },
    },
    overrides,
  );
}
