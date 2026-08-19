import { z } from "zod";
import { DecimalStringSchema } from "../common/decimal-string.js";
import { UuidSchema } from "../common/ids.js";
import { ErrorEnvelopeSchema } from "../errors/error-envelope.js";
import { CueLaneSchema } from "../scene/cue.js";
import { Phase1SessionSnapshotSchema } from "../session/session-snapshot.js";

/**
 * Phase 1 Control WebSocket 支持的全部消息类型（phase-1-build-guide.md §8.2）。
 * Scene 消息只用于协议与持久化集成测试，不执行真实 TTS、Avatar 或游戏动作。
 *
 * Payload 对象一律 loose（允许未知扩展键透传），配合 §6.6
 * 「同一主版本新增可选字段属于兼容变更」；跨校验器语义一致
 * （生成的 JSON Schema 不限制 additionalProperties，ADR 0001 §4）。
 */
export const KNOWN_CONTROL_MESSAGE_TYPES = [
  "server.hello",
  "client.hello",
  "server.ready",
  "heartbeat.ping",
  "heartbeat.pong",
  "clock.ping",
  "clock.pong",
  "session.snapshot",
  "scene.prepared",
  "scene.committed",
  "scene.cancelled",
  "media.stream.open",
  "media.stream.closed",
  "error",
] as const;

export type KnownControlMessageType = (typeof KNOWN_CONTROL_MESSAGE_TYPES)[number];

/** 只有服务端可以发送的消息类型。 */
export const SERVER_TO_CLIENT_MESSAGE_TYPES = [
  "server.hello",
  "server.ready",
  "heartbeat.pong",
  "clock.pong",
  "session.snapshot",
  "scene.prepared",
  "scene.committed",
  "scene.cancelled",
  "error",
] as const;

/** 只有客户端可以发送的消息类型；media.stream.closed 允许双向。 */
export const CLIENT_TO_SERVER_MESSAGE_TYPES = [
  "client.hello",
  "heartbeat.ping",
  "clock.ping",
  "media.stream.open",
  "media.stream.closed",
] as const;

/** 允许任意方向发送的消息类型。 */
export const EITHER_DIRECTION_MESSAGE_TYPES = ["media.stream.closed"] as const;

/**
 * 时钟同步协议（§7.2）：客户端记录 c0 → clock.ping(c0)；
 * Runtime 收到时记录 r1、发出时记录 r2 → clock.pong(c0, r1, r2)。
 * r2 ≥ r1 属于服务端生产者不变量，由 P1 Transport 在 bigint 域断言，
 * 不作为跨校验器的 Schema 约束。
 */
export const ClockPingPayloadSchema = z.looseObject({
  c0: DecimalStringSchema,
});

export const ClockPongPayloadSchema = z.looseObject({
  c0: DecimalStringSchema,
  r1: DecimalStringSchema,
  r2: DecimalStringSchema,
});

export const ServerHelloPayloadSchema = z.looseObject({
  protocolVersion: z.literal(1),
  runtimeVersion: z.string().min(1).max(64),
  heartbeatIntervalMs: z.number().int().positive().max(600_000),
  /** 服务端有界重放窗口的大小（消息条数）。 */
  replayWindowSize: z.number().int().positive().max(100_000),
});

export const ClientHelloPayloadSchema = z.looseObject({
  protocolVersion: z.literal(1),
  clientType: z.enum(["studio", "stage", "overlay", "test-client"]),
  /** 重连时携带的最后 ACK（累计确认）。 */
  lastAck: DecimalStringSchema.optional(),
});

export const ServerReadyPayloadSchema = z.looseObject({});

export const HeartbeatPingPayloadSchema = z.looseObject({});

export const HeartbeatPongPayloadSchema = z.looseObject({});

export const SessionSnapshotPayloadSchema = z.looseObject({
  snapshot: Phase1SessionSnapshotSchema,
});

export const ScenePreparedPayloadSchema = z.looseObject({
  sceneId: UuidSchema,
  cycleId: UuidSchema,
  cues: z.array(z.looseObject({ cueId: UuidSchema, lane: CueLaneSchema })).max(64),
});

export const SceneCommittedPayloadSchema = z.looseObject({
  sceneId: UuidSchema,
  cycleId: UuidSchema,
  committedAtMs: z.number().int().nonnegative(),
});

export const SceneCancelledPayloadSchema = z.looseObject({
  sceneId: UuidSchema,
  cycleId: UuidSchema,
  reason: z.string().min(1).max(256),
});

export const MediaStreamOpenPayloadSchema = z.looseObject({
  streamId: UuidSchema,
  /** Phase 1 只用 binary-test 验证传输；audio/viseme 为后续阶段保留枚举位。 */
  mediaKind: z.enum(["audio", "viseme", "binary-test"]),
  contentType: z.string().min(1).max(128),
});

export const MediaStreamClosedPayloadSchema = z.looseObject({
  streamId: UuidSchema,
  reason: z.string().min(1).max(256),
});

export const ErrorPayloadSchema = z.looseObject({
  error: ErrorEnvelopeSchema,
});

/** type + payload 的判别联合：Envelope 外层校验通过后按 type 校验 Payload。 */
export const ControlPayloadSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("server.hello"), payload: ServerHelloPayloadSchema }),
  z.looseObject({ type: z.literal("client.hello"), payload: ClientHelloPayloadSchema }),
  z.looseObject({ type: z.literal("server.ready"), payload: ServerReadyPayloadSchema }),
  z.looseObject({ type: z.literal("heartbeat.ping"), payload: HeartbeatPingPayloadSchema }),
  z.looseObject({ type: z.literal("heartbeat.pong"), payload: HeartbeatPongPayloadSchema }),
  z.looseObject({ type: z.literal("clock.ping"), payload: ClockPingPayloadSchema }),
  z.looseObject({ type: z.literal("clock.pong"), payload: ClockPongPayloadSchema }),
  z.looseObject({ type: z.literal("session.snapshot"), payload: SessionSnapshotPayloadSchema }),
  z.looseObject({ type: z.literal("scene.prepared"), payload: ScenePreparedPayloadSchema }),
  z.looseObject({ type: z.literal("scene.committed"), payload: SceneCommittedPayloadSchema }),
  z.looseObject({ type: z.literal("scene.cancelled"), payload: SceneCancelledPayloadSchema }),
  z.looseObject({ type: z.literal("media.stream.open"), payload: MediaStreamOpenPayloadSchema }),
  z.looseObject({
    type: z.literal("media.stream.closed"),
    payload: MediaStreamClosedPayloadSchema,
  }),
  z.looseObject({ type: z.literal("error"), payload: ErrorPayloadSchema }),
]);

export type ControlPayload = z.infer<typeof ControlPayloadSchema>;
