/**
 * @bellis/runtime — Phase 1 本地 Runtime（P4 交付）。
 *
 * 通过 @bellis/transport、@bellis/persistence、@bellis/observability 的
 * 包根公开 API 组装：loopback Fastify 边缘、一次性本地 Auth、
 * Control/Media WebSocket 适配、Migration/Ready 生命周期、仅用于协议
 * 验证的 Fake Scene Commit、先数据库 Commit 后发布的顺序保证、
 * Outbox 编排与优雅关闭。
 *
 * 领域逻辑不进入 Route Handler；不导入其他包的 src 私有路径；
 * 不接入真实 LLM/TTS/Live2D/Game。
 */
export {
  parseRuntimeConfig,
  resolveAllowedOrigins,
  normalizeHostHeader,
} from "./bootstrap/config.js";
export type {
  RuntimeConfig,
  RuntimeConfigInput,
  RuntimeConfigIssue,
  ParseConfigResult,
} from "./bootstrap/config.js";
export { startRuntime } from "./bootstrap/lifecycle.js";
export type {
  RuntimeHandle,
  RuntimeOptions,
  RuntimePhase,
  RuntimeStatus,
} from "./bootstrap/lifecycle.js";
export {
  FakeSceneCommitInputSchema,
  FakeSceneCommitService,
} from "./application/commit-fake-scene.js";
export type {
  BroadcastOutcome,
  BroadcastReceipt,
  ControlBroadcast,
  FakeSceneCommitInput,
  FakeSceneCommitResult,
} from "./application/commit-fake-scene.js";
export { buildPhase2SessionSnapshot, buildSessionSnapshot } from "./application/recovery.js";
export { Phase2RuntimeHost } from "./application/phase-2/host.js";
export type { Phase2HostOptions } from "./application/phase-2/host.js";
export { Phase2PerformanceService } from "./application/phase-2/performance-service.js";
export type {
  Phase2PerformanceServiceOptions,
  SignalSubmission,
  SubmissionOutcome,
} from "./application/phase-2/performance-service.js";
export { runFakeModel } from "./application/phase-2/fake-model.js";
export type { FakeModelFixture, FakeModelScenario } from "./application/phase-2/fake-model.js";
export { synthesizeSpeech, frameAt } from "./application/phase-2/fake-tts.js";
export type { FakeTtsResult } from "./application/phase-2/fake-tts.js";
export { RuntimeMediaSender } from "./application/phase-2/media-sender.js";
export type { MediaSenderLimits, OutboundMediaFrame } from "./application/phase-2/media-sender.js";
export {
  PersistenceSceneRepository,
  ControlStagePortAdapter,
} from "./application/phase-2/stage-port-adapter.js";
export type { ControlChannel } from "./application/phase-2/stage-port-adapter.js";
export type { SnapshotReason } from "./application/recovery.js";
export { createRecordingOutboxPublisher } from "./application/outbox-publisher.js";
export type {
  OutboxDeliveryRecord,
  RecordingOutboxPublisher,
} from "./application/outbox-publisher.js";
export {
  ApplicationError,
  mapErrorToEnvelope,
  stableRequestFingerprint,
  toErrorEnvelopeJson,
} from "./errors/mapping.js";
export type { MappedErrorEnvelope } from "./errors/mapping.js";
export { StartupTokenService } from "./auth/startup-token.js";
export type {
  IssuedStartupToken,
  PinnedSessionIdentity,
  StartupTokenReservation,
} from "./auth/startup-token.js";
export type { ExportedControlClaim } from "./websocket/session-store.js";
