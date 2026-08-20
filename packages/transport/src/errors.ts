import type { ErrorCode } from "@bellis/contracts";

/**
 * 稳定传输失败：只有机器码与安全静态文案（phase-1-build-guide.md §6.5）。
 * 绝不携带原始 Payload、Cookie、Token、SQL 或堆栈；文案面向日志与测试，
 * 不承诺客户端可解析（客户端只允许依赖 code）。
 */
export interface TransportFailure {
  readonly code: ErrorCode;
  readonly message: string;
}

/** 框架无关的结果类型：入站 unknown 数据的校验失败以值返回，不抛异常。 */
export type TransportResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: TransportFailure };

export function transportFailure(code: ErrorCode, message: string): TransportFailure {
  return { code, message };
}

/**
 * 出站侧编程错误：调用方试图编码不合法的协议对象。
 * 这是服务端装配缺陷而不是客户端输入，允许抛出；message 只包含字段级
 * 诊断信息，不包含原始 Payload。
 */
export class TransportProtocolViolationError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(`transport protocol violation [${code}]: ${message}`);
    this.name = "TransportProtocolViolationError";
    this.code = code;
  }
}

/** Binary Media 帧的错误码：覆盖编码、增量解析与 Stream 校验。 */
export type MediaErrorCode =
  | "parser_failed"
  | "bad_magic"
  | "unsupported_version"
  | "invalid_media_kind"
  | "bad_flags"
  | "header_too_large"
  | "payload_too_large"
  | "truncated"
  | "invalid_utf8"
  | "invalid_json"
  | "invalid_header";

/** Media 帧编解码/解析的稳定错误；不包含原始字节或 Header 内容。 */
export class MediaFrameError extends Error {
  readonly code: MediaErrorCode;

  constructor(code: MediaErrorCode, message: string) {
    super(`media frame error [${code}]: ${message}`);
    this.name = "MediaFrameError";
    this.code = code;
  }
}

/** Media Stream Registry 的拒绝码；P4 将其映射为 ErrorEnvelope 的稳定 code。 */
export type MediaStreamRejectCode =
  | "session_mismatch"
  | "stream_limit_reached"
  | "total_stream_limit_reached"
  | "stream_already_open"
  | "stream_closed"
  | "unknown_stream"
  | "content_type_mismatch"
  | "media_kind_mismatch"
  | "sequence_violation"
  | "duplicate_frame_id"
  | "deadline_exceeded"
  | "frame_limit_reached";
