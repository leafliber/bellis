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
import { ScenePlanSchema } from "../scene/scene-plan.js";
import { StageCapabilitiesSchema } from "../stage/stage-capabilities.js";
import { SessionSnapshotUnionSchema } from "../session/session-snapshot.js";

/**
 * Control WebSocket 支持的全部消息类型（Phase 1 冻结 + Phase 2 扩展，
 * 见 docs/protocols/control-websocket.md §3 与 docs/protocols/scene-execution.md）。
 *
 * Phase 1 的 scene.prepared/committed/cancelled 保留为对普通订阅客户端
 * 发布的事实通知；Phase 2 的 scene.prepare/ready/commit/started/finished/
 * cancel/cancel.ack 是 Runtime 与 Stage 之间的命令与回执，语义不互换。
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
  // ---- Phase 2 演出纵向链路（scene-execution.md）----
  "stage.capabilities",
  "scene.prepare",
  "scene.ready",
  "scene.commit",
  "scene.started",
  "scene.finished",
  "scene.cancel",
  "scene.cancel.ack",
  "media.stream.announce",
  "media.stream.ready",
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
  "scene.prepare",
  "scene.commit",
  "scene.cancel",
  "media.stream.announce",
] as const;

/** 只有客户端可以发送的消息类型；media.stream.closed 允许双向。 */
export const CLIENT_TO_SERVER_MESSAGE_TYPES = [
  "client.hello",
  "heartbeat.ping",
  "clock.ping",
  "media.stream.open",
  "media.stream.closed",
  "stage.capabilities",
  "scene.ready",
  "scene.started",
  "scene.finished",
  "scene.cancel.ack",
  "media.stream.ready",
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
  /** 版本化快照联合：Phase 1（schemaVersion 1）或 Phase 2（schemaVersion 2）。 */
  snapshot: SessionSnapshotUnionSchema,
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

// ---- Phase 2 演出纵向链路 Payload（scene-execution.md）----

/**
 * Stage 能力声明（stage → runtime）。握手完成后、接受任何 scene.prepare
 * 之前上报；重连后必须重新上报（能力可能随连接代际变化）。
 */
export const StageCapabilitiesPayloadSchema = extensibleJsonObject({
  capabilities: StageCapabilitiesSchema,
});

/**
 * scene.prepare（runtime → stage）：传递完整 ScenePlan 与 Prepare Deadline。
 * Stage 只允许验证与缓冲资源，不允许产生任何对用户可见的副作用；
 * 超过 prepareDeadlineUs 尚未 Ready 的 Lane 由 Stage 标记不可用，
 * Runtime 决定降级或取消。
 */
export const ScenePreparePayloadSchema = extensibleJsonObject({
  plan: ScenePlanSchema,
  /** Prepare 阶段的截止时刻（Runtime 单调微秒，Wire 十进制字符串）。 */
  prepareDeadlineUs: DecimalStringSchema,
});

/** 逐 Lane 的准备结果：ready 或携带稳定原因码的不可用。 */
export const SceneReadyLaneSchema = extensibleJsonObject({
  lane: CueLaneSchema,
  status: z.enum(["ready", "unavailable"]),
  /** 不可用原因码（稳定机器码，如 audio_not_armed / unsupported_content_type）。 */
  reason: z.string().min(1).max(64).optional(),
  /** 该 Lane 下已就绪的 Cue（ready 时非空由生产者保证，Schema 只限上界）。 */
  cueIds: z.array(UuidSchema).max(64),
});

/**
 * scene.ready（stage → runtime）：报告逐 Lane Ready、不可用原因和准备完成
 * 时刻（Stage 本地单调微秒）。Hard Lane 未 Ready 时整组等待或由 Runtime
 * 决定降级/取消，Stage 不自行降级。
 */
export const SceneReadyPayloadSchema = extensibleJsonObject({
  sceneId: UuidSchema,
  cycleId: UuidSchema,
  lanes: z.array(SceneReadyLaneSchema).min(1).max(8),
  /** 准备完成时刻（Stage 本地单调域；由 Offset Estimator 关联 Runtime 域）。 */
  preparedAtStageUs: DecimalStringSchema,
});

/**
 * scene.commit（runtime → stage）：传递当前连接代际内的生效时刻。
 * commitAtRuntimeUs 属于 Runtime 当前进程单调时钟域；Stage 通过当前连接
 * 的 Offset Estimate 映射为本地目标时刻。重连后旧估计清空，旧
 * commitAtRuntimeUs 失效；Commit 到达过晚时 Stage 返回 late_commit
 * （经 scene.finished），由 Runtime 决定取消或降级。
 */
export const SceneCommitPayloadSchema = extensibleJsonObject({
  sceneId: UuidSchema,
  cycleId: UuidSchema,
  /** 生效时刻（Runtime 单调微秒，Wire 十进制字符串）。 */
  commitAtRuntimeUs: DecimalStringSchema,
});

/** 逐 Lane 实际起始时刻：Stage 本地时刻 + 对应的 Runtime 域估算时刻。 */
export const SceneStartedLaneSchema = extensibleJsonObject({
  lane: CueLaneSchema,
  startedAtStageUs: DecimalStringSchema,
  startedAtRuntimeUs: DecimalStringSchema,
});

/**
 * scene.started（stage → runtime）：报告各 Lane 实际起始时刻，
 * 用于同步偏差指标（hardLaneSkewMs）。
 */
export const SceneStartedPayloadSchema = extensibleJsonObject({
  sceneId: UuidSchema,
  cycleId: UuidSchema,
  lanes: z.array(SceneStartedLaneSchema).min(1).max(8),
});

/** 逐 Lane 完成/失败结果。 */
export const SceneFinishedLaneSchema = extensibleJsonObject({
  lane: CueLaneSchema,
  outcome: z.enum(["completed", "failed"]),
  /** 失败原因码（稳定机器码，如 late_commit / buffer_underrun / lane_error）。 */
  reason: z.string().min(1).max(64).optional(),
  finishedAtStageUs: DecimalStringSchema,
});

/**
 * scene.finished（stage → runtime）：报告逐 Lane 完成/失败结果。
 * 从未开始的 Lane（如 late_commit）以 outcome=failed 上报，
 * 不伪造 completed。
 */
export const SceneFinishedPayloadSchema = extensibleJsonObject({
  sceneId: UuidSchema,
  cycleId: UuidSchema,
  lanes: z.array(SceneFinishedLaneSchema).min(1).max(8),
});

/**
 * scene.cancel（runtime → stage）：取消 preparing/scheduled/running 的
 * Scene。Stage 必须在预算内停止并释放所有 Lane，并以 scene.cancel.ack
 * 回执；取消不得影响其他 Scene。
 */
export const SceneCancelPayloadSchema = extensibleJsonObject({
  sceneId: UuidSchema,
  cycleId: UuidSchema,
  reason: z.string().min(1).max(256),
});

/** 逐 Lane 停止回执：stopped=false 时携带原因码。 */
export const SceneCancelAckLaneSchema = extensibleJsonObject({
  lane: CueLaneSchema,
  stopped: z.boolean(),
  reason: z.string().min(1).max(64).optional(),
});

/**
 * scene.cancel.ack（stage → runtime）：报告各 Lane 已停止并释放。
 * Stage 本地连接关闭（未 Ack 即断线）时，Runtime 视为取消结果不确定。
 */
export const SceneCancelAckPayloadSchema = extensibleJsonObject({
  sceneId: UuidSchema,
  cycleId: UuidSchema,
  lanes: z.array(SceneCancelAckLaneSchema).min(1).max(8),
  stoppedAtStageUs: DecimalStringSchema,
});

/**
 * media.stream.announce（runtime → stage）：声明即将发送的 Runtime → Stage
 * Stream。Phase 2 的音频主要是该方向；mediaKind 限定 audio/viseme
 * （binary-test 是 client → server 的测试专用 kind）。sceneId/cueId 可选
 * 关联到 Scene 资源；Stage 确认能力后才允许发送帧。
 */
export const MediaStreamAnnouncePayloadSchema = extensibleJsonObject({
  streamId: UuidSchema,
  mediaKind: z.enum(["audio", "viseme"]),
  contentType: z.string().min(1).max(128),
  sceneId: UuidSchema.optional(),
  cueId: UuidSchema.optional(),
});

/**
 * media.stream.ready（stage → runtime）：确认有界缓冲已建立，允许发送帧。
 * 之后帧走 Media WebSocket（BELL v1 布局不变）；重连后 Stream 必须重新
 * announce，Stage 不得沿用旧连接的 Stream 状态。
 */
export const MediaStreamReadyPayloadSchema = extensibleJsonObject({
  streamId: UuidSchema,
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
      rawExtensibleJsonObject({
        type: z.literal("stage.capabilities"),
        payload: StageCapabilitiesPayloadSchema,
      }),
      rawExtensibleJsonObject({
        type: z.literal("scene.prepare"),
        payload: ScenePreparePayloadSchema,
      }),
      rawExtensibleJsonObject({
        type: z.literal("scene.ready"),
        payload: SceneReadyPayloadSchema,
      }),
      rawExtensibleJsonObject({
        type: z.literal("scene.commit"),
        payload: SceneCommitPayloadSchema,
      }),
      rawExtensibleJsonObject({
        type: z.literal("scene.started"),
        payload: SceneStartedPayloadSchema,
      }),
      rawExtensibleJsonObject({
        type: z.literal("scene.finished"),
        payload: SceneFinishedPayloadSchema,
      }),
      rawExtensibleJsonObject({
        type: z.literal("scene.cancel"),
        payload: SceneCancelPayloadSchema,
      }),
      rawExtensibleJsonObject({
        type: z.literal("scene.cancel.ack"),
        payload: SceneCancelAckPayloadSchema,
      }),
      rawExtensibleJsonObject({
        type: z.literal("media.stream.announce"),
        payload: MediaStreamAnnouncePayloadSchema,
      }),
      rawExtensibleJsonObject({
        type: z.literal("media.stream.ready"),
        payload: MediaStreamReadyPayloadSchema,
      }),
    ]),
  )
  .refine(restoreEscapedOwnKeys);

export type ControlPayload = z.infer<typeof ControlPayloadSchema>;
