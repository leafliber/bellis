/**
 * @bellis/transport — Clock、Control WebSocket 与 Binary Media WebSocket
 * 协议核心（Phase 1 / P1 交付）。
 *
 * 公开边界约定（docs/phase-1/p1-transport.md §5）：
 * - 所有公共导出只从本包根暴露；P4 只能依赖 `@bellis/transport` 包根，
 *   不得读取包内模块路径。
 * - 协议类型一律来自 `@bellis/contracts`，本包不复制 Envelope/Payload/Header
 *   类型；解码入口的输入类型是 unknown。
 * - 微秒、Seq、ACK 在核心中使用 bigint；仅 Wire（JSON 文本）使用十进制字符串。
 * - 状态对象不暴露可变内部数组、Map、Timer 或 Socket；网络写入通过 Effect
 *   交给适配器，核心不持有 Fastify/WebSocket 实例。
 * - 所有具备生命周期/后台行为的对象都有关闭或释放方法，等待支持 Abort。
 *
 * 三块能力：
 * - Clock：SystemMonotonicClock（生产单调时钟）与 ClockOffsetEstimator
 *   （客户端时钟偏移估计，样本校验 + 确定性选择策略）。
 * - Control：分层解码（codec）、连接状态机、服务端 Seq/ACK/Replay、
 *   messageId 去重、幂等键要求、心跳/Hello/Deadline 与有界优先级发送队列，
 *   全部由 ControlSession 聚合并以 ControlEffect 输出副作用。
 * - Media：冻结布局的帧编解码、以 WS 消息边界为准的增量 Parser、
 *   以及带资源上限与顺序/去重校验的 Stream Registry。
 */

// ---- Clock ----
export { SystemMonotonicClock } from "./clock/system-monotonic-clock.js";
export { ClockOffsetEstimator } from "./clock/offset-estimator.js";
export type {
  ClockEstimate,
  ClockOffsetEstimatorOptions,
  ClockSample,
} from "./clock/offset-estimator.js";

// ---- 错误与稳定失败 ----
export { MediaFrameError, TransportProtocolViolationError } from "./errors.js";
export type {
  MediaErrorCode,
  MediaStreamRejectCode,
  TransportFailure,
  TransportResult,
} from "./errors.js";

// ---- Control：编解码 ----
export {
  DEFAULT_MAX_CONTROL_TEXT_BYTES,
  decodeControlMessage,
  encodeControlMessage,
  isDirectionAllowed,
} from "./control/codec.js";
export type { ControlDecodeOptions } from "./control/codec.js";

// ---- Control：状态机 ----
export { CONTROL_CONNECTION_STATES } from "./control/connection-state.js";
export type { ControlConnectionState } from "./control/connection-state.js";

// ---- Control：去重 / Replay / 队列 ----
export { MessageDeduplicator } from "./control/message-deduplicator.js";
export type { MessageDeduplicatorOptions } from "./control/message-deduplicator.js";
export { ReplayWindow } from "./control/replay-window.js";
export type { ReplayMessage, ReplayOutcome, ReplayWindowOptions } from "./control/replay-window.js";
export { BoundedSendQueue } from "./control/bounded-send-queue.js";
export type {
  EnqueueOutcome,
  QueuedSend,
  SendPriority,
  SendQueueLimits,
  SendQueueOptions,
} from "./control/bounded-send-queue.js";

// ---- Control：会话与 Effect ----
export { CONTROL_CLOSE_CODES } from "./control/effects.js";
export type { ControlCloseCode, ControlEffect } from "./control/effects.js";
export { ControlSession } from "./control/control-session.js";
export type {
  AcceptedClientMessage,
  AcknowledgeOutcome,
  ControlHeartbeatOptions,
  ControlLogicalState,
  ControlSessionOptions,
  ControlSendQueueOptions,
  PendingServerMessage,
  ServerEnqueueResult,
  ServerMessageInput,
} from "./control/control-session.js";

// ---- Media ----
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
} from "./media/frame-codec.js";
export type { MediaFrame, MediaFrameLimits, MediaKindName } from "./media/frame-codec.js";
export { MediaFrameParser } from "./media/incremental-parser.js";
export type { MediaFrameParserOptions } from "./media/incremental-parser.js";
export { MediaStreamRegistry } from "./media/stream-registry.js";
export type {
  CloseStreamResult,
  MediaFrameAcceptResult,
  MediaStreamOpenResult,
  MediaStreamRegistryOptions,
  OpenStreamInput,
} from "./media/stream-registry.js";
