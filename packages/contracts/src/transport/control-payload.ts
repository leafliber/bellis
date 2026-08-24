import { z } from "zod";
import { DecimalStringSchema } from "../common/decimal-string.js";
import { UuidSchema } from "../common/ids.js";
import {
  escapeDangerousOwnKeys,
  extensibleJsonObject,
  rawExtensibleJsonObject,
  restoreEscapedOwnKeys,
} from "../common/json-value.js";
import { ErrorEnvelopeSchema } from "../errors/error-envelope.js";
import { CueLaneSchema } from "../scene/cue.js";
import { Phase1SessionSnapshotSchema } from "../session/session-snapshot.js";

/**
 * Phase 1 Control WebSocket 支持的全部消息类型（docs/phase-1-reference.md）。
 * Scene 消息只用于协议与持久化集成测试，不执行真实 TTS、Avatar 或游戏动作。
 *
 * Payload 对象一律 extensibleJsonObject：未知扩展键以 JsonValueSchema
 * 作为 catch-all（扩展值必须是 JSON 值），配合 §6.6「同一主版本新增
 * 可选字段属于兼容变更」；生成的 JSON Schema 为 additionalProperties:
 * JsonValueSchema，Zod 与两种 Ajv dialect 对同一 Fixture 判定一致
 * （ADR 0001 §4）。
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
export const ClockPingPayloadSchema = extensibleJsonObject({
  c0: DecimalStringSchema,
});

export const ClockPongPayloadSchema = extensibleJsonObject({
  c0: DecimalStringSchema,
  r1: DecimalStringSchema,
  r2: DecimalStringSchema,
});

export const ServerHelloPayloadSchema = extensibleJsonObject({
  protocolVersion: z.literal(1),
  runtimeVersion: z.string().min(1).max(64),
  heartbeatIntervalMs: z.number().int().positive().max(600_000),
  /** 服务端有界重放窗口的大小（消息条数）。 */
  replayWindowSize: z.number().int().positive().max(100_000),
});

export const ClientHelloPayloadSchema = extensibleJsonObject({
  protocolVersion: z.literal(1),
  clientType: z.enum(["studio", "stage", "overlay", "test-client"]),
  /** 重连时携带的最后 ACK（累计确认）。 */
  lastAck: DecimalStringSchema.optional(),
});

export const ServerReadyPayloadSchema = extensibleJsonObject({});

export const HeartbeatPingPayloadSchema = extensibleJsonObject({});

export const HeartbeatPongPayloadSchema = extensibleJsonObject({});

export const SessionSnapshotPayloadSchema = extensibleJsonObject({
  snapshot: Phase1SessionSnapshotSchema,
});

export const ScenePreparedPayloadSchema = extensibleJsonObject({
  sceneId: UuidSchema,
  cycleId: UuidSchema,
  cues: z.array(extensibleJsonObject({ cueId: UuidSchema, lane: CueLaneSchema })).max(64),
});

export const SceneCommittedPayloadSchema = extensibleJsonObject({
  sceneId: UuidSchema,
  cycleId: UuidSchema,
  committedAtMs: z.number().int().nonnegative(),
});

export const SceneCancelledPayloadSchema = extensibleJsonObject({
  sceneId: UuidSchema,
  cycleId: UuidSchema,
  reason: z.string().min(1).max(256),
});

export const MediaStreamOpenPayloadSchema = extensibleJsonObject({
  streamId: UuidSchema,
  /** Phase 1 只用 binary-test 验证传输；audio/viseme 为后续阶段保留枚举位。 */
  mediaKind: z.enum(["audio", "viseme", "binary-test"]),
  contentType: z.string().min(1).max(128),
});

export const MediaStreamClosedPayloadSchema = extensibleJsonObject({
  streamId: UuidSchema,
  reason: z.string().min(1).max(256),
});

export const ErrorPayloadSchema = extensibleJsonObject({
  error: ErrorEnvelopeSchema,
});

/**
 * type + payload 的判别联合：Envelope 外层校验通过后按 type 校验 Payload。
 *
 * 成员用 rawExtensibleJsonObject（判别联合成员必须是 ZodObject）；对象级
 * 危险扩展键（如 "__proto__"）由包裹整个联合的 preprocess/refine 统一
 * 转义/还原，成员内嵌的 Payload 对象则各自携带转义（extensibleJsonObject）。
 */
export const ControlPayloadSchema = z
  .preprocess(
    escapeDangerousOwnKeys,
    z.discriminatedUnion("type", [
      rawExtensibleJsonObject({
        type: z.literal("server.hello"),
        payload: ServerHelloPayloadSchema,
      }),
      rawExtensibleJsonObject({
        type: z.literal("client.hello"),
        payload: ClientHelloPayloadSchema,
      }),
      rawExtensibleJsonObject({
        type: z.literal("server.ready"),
        payload: ServerReadyPayloadSchema,
      }),
      rawExtensibleJsonObject({
        type: z.literal("heartbeat.ping"),
        payload: HeartbeatPingPayloadSchema,
      }),
      rawExtensibleJsonObject({
        type: z.literal("heartbeat.pong"),
        payload: HeartbeatPongPayloadSchema,
      }),
      rawExtensibleJsonObject({ type: z.literal("clock.ping"), payload: ClockPingPayloadSchema }),
      rawExtensibleJsonObject({ type: z.literal("clock.pong"), payload: ClockPongPayloadSchema }),
      rawExtensibleJsonObject({
        type: z.literal("session.snapshot"),
        payload: SessionSnapshotPayloadSchema,
      }),
      rawExtensibleJsonObject({
        type: z.literal("scene.prepared"),
        payload: ScenePreparedPayloadSchema,
      }),
      rawExtensibleJsonObject({
        type: z.literal("scene.committed"),
        payload: SceneCommittedPayloadSchema,
      }),
      rawExtensibleJsonObject({
        type: z.literal("scene.cancelled"),
        payload: SceneCancelledPayloadSchema,
      }),
      rawExtensibleJsonObject({
        type: z.literal("media.stream.open"),
        payload: MediaStreamOpenPayloadSchema,
      }),
      rawExtensibleJsonObject({
        type: z.literal("media.stream.closed"),
        payload: MediaStreamClosedPayloadSchema,
      }),
      rawExtensibleJsonObject({ type: z.literal("error"), payload: ErrorPayloadSchema }),
    ]),
  )
  .refine(restoreEscapedOwnKeys);

export type ControlPayload = z.infer<typeof ControlPayloadSchema>;
