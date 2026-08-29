/**
 * @bellis/contracts — 唯一协议源（docs/phase-1-reference.md）。
 *
 * Zod Schema 是 TypeScript 领域类型、REST、WebSocket 和持久化 Payload 的
 * 唯一真相来源；TypeScript 类型一律用 z.infer 推导，禁止复制手写副本。
 * 公开导出只从本包根暴露，禁止跨包读取 src 私有路径。
 */

export {
  MAX_DECIMAL_STRING_LENGTH,
  DecimalStringSchema,
  decimalStringLte,
  formatDecimalString,
  parseDecimalString,
} from "./common/decimal-string.js";
export {
  SPAN_ID_PATTERN,
  TRACE_ID_PATTERN,
  UUID_PATTERN,
  SpanIdSchema,
  TraceIdSchema,
  UuidSchema,
} from "./common/ids.js";
export { JsonValueSchema, extensibleJsonObject } from "./common/json-value.js";
export type { JsonValue } from "./common/json-value.js";
export { TraceContextSchema } from "./common/trace-context.js";
export type { TraceContext } from "./common/trace-context.js";
export type { MonotonicClock } from "./common/clock.js";

export { ErrorCodeSchema, ErrorEnvelopeSchema } from "./errors/error-envelope.js";
export type { ErrorCode, ErrorEnvelope } from "./errors/error-envelope.js";

export { SignalSchema } from "./signal/signal.js";
export type { Signal } from "./signal/signal.js";
export {
  AudienceBatchSchema,
  AudienceMessageSchema,
  AudienceTopicSchema,
} from "./signal/audience-batch.js";
export type { AudienceBatch, AudienceMessage, AudienceTopic } from "./signal/audience-batch.js";
export { IngestedSignalSchema, SignalPriorityClassSchema } from "./signal/ingested-signal.js";
export type { IngestedSignal, SignalPriorityClass } from "./signal/ingested-signal.js";

export { ActionFrameSchema } from "./decision/action-frame.js";
export type { ActionFrame } from "./decision/action-frame.js";
export { DecisionPacketSchema } from "./decision/decision-packet.js";
export type { DecisionPacket } from "./decision/decision-packet.js";
export { ToolCallSchema } from "./decision/tool-call.js";
export type { ToolCall } from "./decision/tool-call.js";
export {
  AvatarChannelSchema,
  AvatarIntentSchema,
  GameIntentSchema,
  GameTimeRelationSchema,
  OverlayIntentSchema,
  SpeechIntentSchema,
  SyncPolicySchema,
} from "./decision/intents.js";
export type {
  ActionSyncLevel,
  AvatarChannel,
  AvatarIntent,
  GameIntent,
  GameTimeRelation,
  OverlayIntent,
  SpeechIntent,
  SyncPolicy,
} from "./decision/intents.js";
export { CycleSnapshotSchema, RecentUtteranceSchema } from "./decision/cycle-snapshot.js";
export type { CycleSnapshot, RecentUtterance } from "./decision/cycle-snapshot.js";
export {
  ToolCacheSourceSchema,
  ToolExecutionModeSchema,
  ToolOutcomeSchema,
  ToolResultSchema,
  ToolRunStateSchema,
  ToolSemanticSchema,
} from "./decision/tool-run.js";
export type {
  ToolCacheSource,
  ToolExecutionMode,
  ToolOutcome,
  ToolResult,
  ToolRunState,
  ToolSemantic,
} from "./decision/tool-run.js";

export { CueLaneSchema, CueSchema } from "./scene/cue.js";
export type { Cue, CueLane } from "./scene/cue.js";
export { SceneSchema, SyncGroupSchema, SyncLevelSchema } from "./scene/scene.js";
export type { Scene, SyncGroup, SyncLevel } from "./scene/scene.js";
export { SceneExecutionStateSchema, ScenePlanSchema } from "./scene/scene-plan.js";
export type { SceneExecutionState, ScenePlan } from "./scene/scene-plan.js";
export { StageCapabilitiesSchema } from "./stage/stage-capabilities.js";
export type { StageCapabilities } from "./stage/stage-capabilities.js";

export { OutboxMessageSchema } from "./session/outbox-message.js";
export type { OutboxMessage } from "./session/outbox-message.js";
export { Phase1SessionSnapshotSchema } from "./session/session-snapshot.js";
export type { Phase1SessionSnapshot } from "./session/session-snapshot.js";
export {
  ActiveSceneStateSchema,
  Phase2SessionSnapshotSchema,
  SessionSnapshotUnionSchema,
} from "./session/session-snapshot.js";
export type {
  ActiveSceneState,
  Phase2SessionSnapshot,
  SessionSnapshot,
} from "./session/session-snapshot.js";
export { SessionRecordSchema } from "./session/session-record.js";
export type { SessionRecord } from "./session/session-record.js";
export {
  PHASE_2_AUDIT_PAYLOAD_VERSION,
  Phase2DecisionPacketPayloadSchema,
  Phase2ScenePlanCompiledPayloadSchema,
  Phase2SignalAcceptedPayloadSchema,
  SceneLifecyclePayloadSchema,
} from "./session/phase-2-records.js";
export type {
  Phase2DecisionPacketPayload,
  Phase2ScenePlanCompiledPayload,
  Phase2SignalAcceptedPayload,
  SceneLifecyclePayload,
} from "./session/phase-2-records.js";
export { PHASE_3_AUDIT_PAYLOAD_VERSION } from "./session/phase-3-records.js";
export {
  Phase3BatchSealedPayloadSchema,
  Phase3CycleAdoptedPayloadSchema,
  Phase3CycleFinishedPayloadSchema,
  Phase3ModelRequestPayloadSchema,
  Phase3SignalIngestedPayloadSchema,
  Phase3ToolRunPayloadSchema,
  Phase3TurnFinishedPayloadSchema,
  Phase3TurnStartedPayloadSchema,
} from "./session/phase-3-records.js";
export type {
  Phase3BatchSealedPayload,
  Phase3CycleAdoptedPayload,
  Phase3CycleFinishedPayload,
  Phase3ModelRequestPayload,
  Phase3SignalIngestedPayload,
  Phase3ToolRunPayload,
  Phase3TurnFinishedPayload,
  Phase3TurnStartedPayload,
} from "./session/phase-3-records.js";

export {
  CONTROL_MESSAGE_TYPE_PATTERN,
  CONTROL_PROTOCOL_VERSION,
  ClientControlEnvelopeSchema,
  ControlEnvelopeSchema,
  EnvelopeTraceSchema,
  ServerControlEnvelopeSchema,
  createClientControlEnvelopeSchema,
  createServerControlEnvelopeSchema,
} from "./transport/control-envelope.js";
export type {
  ClientControlEnvelope,
  ControlEnvelope,
  EnvelopeTrace,
  ServerControlEnvelope,
} from "./transport/control-envelope.js";
export {
  CLIENT_TO_SERVER_MESSAGE_TYPES,
  ClockPingPayloadSchema,
  ClockPongPayloadSchema,
  ControlPayloadSchema,
  EITHER_DIRECTION_MESSAGE_TYPES,
  ErrorPayloadSchema,
  HeartbeatPingPayloadSchema,
  HeartbeatPongPayloadSchema,
  KNOWN_CONTROL_MESSAGE_TYPES,
  MediaStreamAnnouncePayloadSchema,
  MediaStreamClosedPayloadSchema,
  MediaStreamOpenPayloadSchema,
  MediaStreamReadyPayloadSchema,
  SceneCancelAckLaneSchema,
  SceneCancelAckPayloadSchema,
  SceneCancelPayloadSchema,
  SceneCancelledPayloadSchema,
  SceneCommitPayloadSchema,
  SceneCommittedPayloadSchema,
  SceneFinishedLaneSchema,
  SceneFinishedPayloadSchema,
  ScenePreparedPayloadSchema,
  ScenePreparePayloadSchema,
  SceneReadyLaneSchema,
  SceneReadyPayloadSchema,
  SceneStartedLaneSchema,
  SceneStartedPayloadSchema,
  SERVER_TO_CLIENT_MESSAGE_TYPES,
  ServerHelloPayloadSchema,
  ServerReadyPayloadSchema,
  SessionSnapshotPayloadSchema,
  StageCapabilitiesPayloadSchema,
  ClientHelloPayloadSchema,
} from "./transport/control-payload.js";
export type { ControlPayload, KnownControlMessageType } from "./transport/control-payload.js";
export { MediaFrameHeaderSchema } from "./transport/media-frame-header.js";
export type { MediaFrameHeader } from "./transport/media-frame-header.js";
export {
  PHASE_2_PCM_BYTES_PER_SAMPLE,
  PHASE_2_PCM_CHANNELS,
  PHASE_2_PCM_CONTENT_TYPE,
  PHASE_2_PCM_FRAME_BYTES,
  PHASE_2_PCM_FRAME_DURATION_US,
  PHASE_2_PCM_SAMPLES_PER_FRAME,
  PHASE_2_PCM_SAMPLE_RATE_HZ,
} from "./transport/media-baseline.js";

export { CONTRACT_SCHEMA_ENTRIES, generateJsonSchemaFiles } from "./json-schema.js";
export type { ContractSchemaKey, GeneratedSchemaFile } from "./json-schema.js";
