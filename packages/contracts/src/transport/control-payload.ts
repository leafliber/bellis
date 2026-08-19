import { z } from "zod";
import { DecimalStringSchema, decimalStringLte } from "../common/decimal-string.js";
import { UuidSchema } from "../common/ids.js";
import { ErrorEnvelopeSchema } from "../errors/error-envelope.js";
import { Phase1SessionSnapshotSchema } from "../session/session-snapshot.js";
import { CueLaneSchema } from "../scene/cue.js";

/**
 * Phase 1 Control WebSocket 支持的全部消息类型（phase-1-build-guide.md §8.2）。
 * Scene 消息只用于协议与持久化集成测试，不执行真实 TTS、Avatar 或游戏动作。
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
 */
export const ClockPingPayloadSchema = z.object({
  c0: DecimalStringSchema,
});

export const ClockPongPayloadSchema = z
  .object({
    c0: DecimalStringSchema,
    r1: DecimalStringSchema,
    r2: DecimalStringSchema,
  })
  .refine((payload) => decimalStringLte(payload.r1, payload.r2), {
    message: "r2 must be greater than or equal to r1",
  });

export const ServerHelloPayloadSchema = z.object({
  protocolVersion: z.literal(1),
  runtimeVersion: z.string().min(1).max(64),
  heartbeatIntervalMs: z.number().int().positive().max(600_000),
  /** 服务端有界重放窗口的大小（消息条数）。 */
  replayWindowSize: z.number().int().positive().max(100_000),
});

export const ClientHelloPayloadSchema = z.object({
  protocolVersion: z.literal(1),
  clientType: z.enum(["studio", "stage", "overlay", "test-client"]),
  /** 重连时携带的最后 ACK（累计确认）。 */
  lastAck: DecimalStringSchema.optional(),
});

export const ServerReadyPayloadSchema = z.object({});

export const HeartbeatPingPayloadSchema = z.object({});

export const HeartbeatPongPayloadSchema = z.object({});

export const SessionSnapshotPayloadSchema = z.object({
  snapshot: Phase1SessionSnapshotSchema,
});

export const ScenePreparedPayloadSchema = z.object({
  sceneId: UuidSchema,
  cycleId: UuidSchema,
  cues: z.array(z.object({ cueId: UuidSchema, lane: CueLaneSchema })).max(64),
});

export const SceneCommittedPayloadSchema = z.object({
  sceneId: UuidSchema,
  cycleId: UuidSchema,
  committedAtMs: z.number().int().nonnegative(),
});

export const SceneCancelledPayloadSchema = z.object({
  sceneId: UuidSchema,
  cycleId: UuidSchema,
  reason: z.string().min(1).max(256),
});

export const MediaStreamOpenPayloadSchema = z.object({
  streamId: UuidSchema,
  /** Phase 1 只用 binary-test 验证传输；audio/viseme 为后续阶段保留枚举位。 */
  mediaKind: z.enum(["audio", "viseme", "binary-test"]),
  contentType: z.string().min(1).max(128),
});

export const MediaStreamClosedPayloadSchema = z.object({
  streamId: UuidSchema,
  reason: z.string().min(1).max(256),
});

export const ErrorPayloadSchema = z.object({
  error: ErrorEnvelopeSchema,
});

/** type + payload 的判别联合：Envelope 外层校验通过后按 type 校验 Payload。 */
export const ControlPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("server.hello"), payload: ServerHelloPayloadSchema }),
  z.object({ type: z.literal("client.hello"), payload: ClientHelloPayloadSchema }),
  z.object({ type: z.literal("server.ready"), payload: ServerReadyPayloadSchema }),
  z.object({ type: z.literal("heartbeat.ping"), payload: HeartbeatPingPayloadSchema }),
  z.object({ type: z.literal("heartbeat.pong"), payload: HeartbeatPongPayloadSchema }),
  z.object({ type: z.literal("clock.ping"), payload: ClockPingPayloadSchema }),
  z.object({ type: z.literal("clock.pong"), payload: ClockPongPayloadSchema }),
  z.object({ type: z.literal("session.snapshot"), payload: SessionSnapshotPayloadSchema }),
  z.object({ type: z.literal("scene.prepared"), payload: ScenePreparedPayloadSchema }),
  z.object({ type: z.literal("scene.committed"), payload: SceneCommittedPayloadSchema }),
  z.object({ type: z.literal("scene.cancelled"), payload: SceneCancelledPayloadSchema }),
  z.object({ type: z.literal("media.stream.open"), payload: MediaStreamOpenPayloadSchema }),
  z.object({ type: z.literal("media.stream.closed"), payload: MediaStreamClosedPayloadSchema }),
  z.object({ type: z.literal("error"), payload: ErrorPayloadSchema }),
]);

export type ControlPayload = z.infer<typeof ControlPayloadSchema>;
