/**
 * @bellis/transport/browser — 浏览器安全入口（Phase 2 Browser Bundle
 * Spike，docs/phase-2-development-guide.md §5.6，ADR 0003）。
 *
 * 边界约定：
 * - 本入口只重新导出可在浏览器运行的核心：Control 编解码/方向白名单、
 *   连接状态、去重/Replay/有界发送队列、时钟偏移估计、浏览器单调时钟、
 *   媒体帧编解码与 Stream Registry。协议算法与 Node 侧共用同一实现，
 *   不复制 Offset/Envelope/帧布局代码。
 * - Node-only 能力（SystemMonotonicClock 基于 process.hrtime、
 *   ControlSession 服务端会话核心）只从包根 "." 暴露，禁止出现在
 *   浏览器 Bundle；browser-entry 测试静态扫描可达文件图强制该约束。
 * - 外部依赖只允许 @bellis/contracts（纯 Zod，无 Node API）。
 */

// ---- 错误与稳定失败 ----
export { MediaFrameError, TransportProtocolViolationError } from "../errors.js";
export type {
  MediaErrorCode,
  MediaStreamRejectCode,
  TransportFailure,
  TransportResult,
} from "../errors.js";

// ---- Control：编解码（Node/浏览器共用）----
export {
  DEFAULT_MAX_CONTROL_TEXT_BYTES,
  decodeControlMessage,
  encodeControlMessage,
  isDirectionAllowed,
} from "../control/codec.js";
export type { ControlDecodeOptions } from "../control/codec.js";

// ---- Control：连接状态 / 去重 / Replay / 队列 ----
export { CONTROL_CONNECTION_STATES } from "../control/connection-state.js";
export type { ControlConnectionState } from "../control/connection-state.js";
export { MessageDeduplicator } from "../control/message-deduplicator.js";
export type { MessageDeduplicatorOptions } from "../control/message-deduplicator.js";
export { ReplayWindow } from "../control/replay-window.js";
export type {
  ReplayMessage,
  ReplayOutcome,
  ReplayWindowOptions,
} from "../control/replay-window.js";
export { BoundedSendQueue } from "../control/bounded-send-queue.js";
export type {
  EnqueueOutcome,
  QueuedSend,
  SendPriority,
  SendQueueLimits,
  SendQueueOptions,
} from "../control/bounded-send-queue.js";
export { CONTROL_CLOSE_CODES } from "../control/effects.js";
export type { ControlCloseCode, ControlEffect } from "../control/effects.js";

// ---- Clock：浏览器单调时钟 + 偏移估计 ----
export { BrowserMonotonicClock } from "../clock/browser-monotonic-clock.js";
export { ClockOffsetEstimator } from "../clock/offset-estimator.js";
export type {
  ClockEstimate,
  ClockOffsetEstimatorOptions,
  ClockSample,
} from "../clock/offset-estimator.js";

// ---- Media：帧编解码 / 增量解析 / Stream Registry（Uint8Array，共用实现）----
export {
  DEFAULT_MAX_MEDIA_HEADER_BYTES,
  DEFAULT_MAX_MEDIA_PAYLOAD_BYTES,
  MEDIA_FRAME_PREFIX_BYTES,
  MEDIA_FRAME_PROTOCOL_VERSION,
  MEDIA_KIND_CODES,
  MEDIA_MAGIC,
  encodeMediaFrame,
  mediaKindFromCode,
  mediaKindToCode,
  validateMediaFrameHeader,
} from "../media/frame-codec.js";
export type { MediaFrame, MediaFrameLimits, MediaKindName } from "../media/frame-codec.js";
export { MediaFrameParser } from "../media/incremental-parser.js";
export type { MediaFrameParserOptions } from "../media/incremental-parser.js";
export { MediaStreamRegistry } from "../media/stream-registry.js";
export type {
  CloseStreamResult,
  MediaFrameAcceptResult,
  MediaStreamOpenResult,
  MediaStreamRegistryOptions,
  OpenStreamInput,
} from "../media/stream-registry.js";
