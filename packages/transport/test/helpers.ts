import type {
  ClientControlEnvelope,
  ControlEnvelope,
  JsonValue,
  ServerControlEnvelope,
} from "@bellis/contracts";

/**
 * 共享测试工厂：合法 Wire 形态的 Envelope/帧构造器。
 * 全部走 JSON.stringify（Wire 真实形态），不绕过编解码管线。
 */

export const TRACE_ID = "0123456789abcdef0123456789abcdef";
export const SPAN_ID = "0123456789abcdef";
export const SESSION_ID = "11111111-1111-4111-8111-111111111111";
export const MESSAGE_ID = "77777777-7777-4777-8777-777777777777";
export const ALT_MESSAGE_ID = "88888888-8888-4888-8888-888888888888";
export const STREAM_ID = "99999999-9999-4999-8999-999999999999";
export const FRAME_ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const FRAME_ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const SCENE_ID = "44444444-4444-4444-8444-444444444444";
export const CYCLE_ID = "33333333-3333-4333-8333-333333333333";
export const RUNTIME_VERSION = "0.1.0-phase1-test";

/** 全部 14 种消息类型的合法 Payload（与 Contracts Schema 对齐）。 */
export const VALID_PAYLOADS: Readonly<Record<string, JsonValue>> = {
  "server.hello": {
    protocolVersion: 1,
    runtimeVersion: RUNTIME_VERSION,
    heartbeatIntervalMs: 30000,
    replayWindowSize: 512,
  },
  "client.hello": { protocolVersion: 1, clientType: "studio" },
  "server.ready": {},
  "heartbeat.ping": {},
  "heartbeat.pong": {},
  "clock.ping": { c0: "1000" },
  "clock.pong": { c0: "1000", r1: "1010", r2: "1011" },
  "session.snapshot": {
    snapshot: {
      schemaVersion: 1,
      reason: "initial",
      sessionId: SESSION_ID,
      sessionStatus: "ready",
      latestServerSeq: "5",
      signalWatermarks: [{ source: "danmaku", watermark: "42" }],
      activeScene: null,
      openMediaStreams: [],
      runtimeVersion: RUNTIME_VERSION,
      generatedAtMs: 0,
    },
  },
  "scene.prepared": { sceneId: SCENE_ID, cycleId: CYCLE_ID, cues: [] },
  "scene.committed": { sceneId: SCENE_ID, cycleId: CYCLE_ID, committedAtMs: 0 },
  "scene.cancelled": { sceneId: SCENE_ID, cycleId: CYCLE_ID, reason: "test" },
  "media.stream.open": {
    streamId: STREAM_ID,
    mediaKind: "binary-test",
    contentType: "application/octet-stream",
  },
  "media.stream.closed": { streamId: STREAM_ID, reason: "test" },
  error: {
    error: {
      code: "invalid_message",
      message: "test error",
      retryable: false,
      traceId: TRACE_ID,
    },
  },
};

export interface EnvelopeOverrides {
  type?: string;
  messageId?: string;
  sessionId?: string;
  sentAtUs?: string;
  deadlineUs?: string;
  payload?: JsonValue;
  traceId?: string;
}

/** 客户端方向 Wire 文本。 */
export function clientText(
  overrides: EnvelopeOverrides = {},
  extra: Record<string, unknown> = {},
): string {
  const o = { type: "heartbeat.ping", ...overrides };
  const envelope: ClientControlEnvelope = {
    version: 1,
    direction: "client",
    type: o.type ?? "heartbeat.ping",
    messageId: o.messageId ?? MESSAGE_ID,
    sessionId: o.sessionId ?? SESSION_ID,
    trace: { traceId: o.traceId ?? TRACE_ID },
    sentAtUs: o.sentAtUs ?? "1000",
    ...(o.deadlineUs === undefined ? {} : { deadlineUs: o.deadlineUs }),
    payload: (o.payload ?? VALID_PAYLOADS[o.type ?? "heartbeat.ping"] ?? {}) as JsonValue,
    ...extra,
  };
  return JSON.stringify(envelope);
}

/** 服务端方向 Wire 文本。 */
export function serverText(
  overrides: EnvelopeOverrides = {},
  extra: Record<string, unknown> = {},
): string {
  const o = { type: "server.ready", ...overrides };
  const envelope: ServerControlEnvelope = {
    version: 1,
    direction: "server",
    type: o.type ?? "server.ready",
    messageId: o.messageId ?? MESSAGE_ID,
    sessionId: o.sessionId ?? SESSION_ID,
    trace: { traceId: o.traceId ?? TRACE_ID },
    sentAtUs: o.sentAtUs ?? "1000",
    ...(o.deadlineUs === undefined ? {} : { deadlineUs: o.deadlineUs }),
    seq: "1",
    payload: (o.payload ?? VALID_PAYLOADS[o.type ?? "server.ready"] ?? {}) as JsonValue,
    ...extra,
  };
  return JSON.stringify(envelope);
}

export function parseJson(text: string): ControlEnvelope {
  return JSON.parse(text) as ControlEnvelope;
}
