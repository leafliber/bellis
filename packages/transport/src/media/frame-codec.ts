import { MediaFrameHeaderSchema } from "@bellis/contracts";
import type { MediaFrameHeader } from "@bellis/contracts";
import { MediaFrameError } from "../errors.js";

/**
 * Binary Media 帧布局（docs/reference/phase-1.md，冻结布局）：
 *
 * ```text
 * 4 bytes  magic = ASCII "BELL"
 * 1 byte   protocol version = 1
 * 1 byte   media kind（1=audio, 2=viseme, 3=binary-test）
 * 2 bytes  flags, unsigned LE（Phase 1 恒为 0，非 0 拒绝）
 * 4 bytes  header length, unsigned LE
 * N bytes  UTF-8 JSON header（MediaFrameHeaderSchema）
 * M bytes  binary payload
 * ```
 *
 * 帧边界 = WebSocket 消息边界：布局中没有 Payload 长度字段，
 * Payload 占据该 WS 二进制消息的剩余字节（见 binary-media-websocket.md）。
 * media kind 不在 Header JSON 内（Header 由 MediaFrameHeaderSchema 冻结），
 * 由帧内 kind 字节承载：编码时必须显式提供，解析时从字节还原。
 * Phase 1 的 Payload 只是随机测试字节，不是可播放音频。
 */

export const MEDIA_MAGIC = Object.freeze([0x42, 0x45, 0x4c, 0x4c]) as readonly number[];

export const MEDIA_FRAME_PROTOCOL_VERSION = 1;

export const MEDIA_KIND_CODES = {
  audio: 1,
  viseme: 2,
  "binary-test": 3,
} as const;

export type MediaKindName = keyof typeof MEDIA_KIND_CODES;

/** 固定前缀长度：magic(4) + version(1) + kind(1) + flags(2) + headerLength(4)。 */
export const MEDIA_FRAME_PREFIX_BYTES = 12;

/** Header JSON 的默认上限（字节）。 */
export const DEFAULT_MAX_MEDIA_HEADER_BYTES = 16 * 1024;

/** 单帧 Payload 的默认上限（字节）。 */
export const DEFAULT_MAX_MEDIA_PAYLOAD_BYTES = 1024 * 1024;

export interface MediaFrameLimits {
  readonly maxHeaderBytes?: number;
  readonly maxPayloadBytes?: number;
}

export interface MediaFrame {
  readonly header: MediaFrameHeader;
  readonly payload: Uint8Array;
  readonly mediaKind: MediaKindName;
}

export function mediaKindToCode(kind: MediaKindName): number {
  return MEDIA_KIND_CODES[kind];
}

export function mediaKindFromCode(code: number): MediaKindName | null {
  switch (code) {
    case MEDIA_KIND_CODES.audio:
      return "audio";
    case MEDIA_KIND_CODES.viseme:
      return "viseme";
    case MEDIA_KIND_CODES["binary-test"]:
      return "binary-test";
    default:
      return null;
  }
}

/** 校验 Header 对象（编码与解析共用）；失败抛稳定的 MediaFrameError。 */
export function validateMediaFrameHeader(header: unknown): MediaFrameHeader {
  const check = MediaFrameHeaderSchema.safeParse(header);
  if (!check.success) {
    throw new MediaFrameError("invalid_header", "media frame header does not match schema");
  }
  return check.data;
}

/**
 * 共享 UTF-8 编码器：Node 与浏览器都可用的全局 TextEncoder
 * （WHATWG 标准；Node ≥ 11 内置）。编码算法不做环境分支。
 */
const UTF8_ENCODER = new TextEncoder();

/**
 * 编码一帧：Header 语义校验 → 紧凑 JSON → UTF-8 → 冻结布局。
 * Header/Payload 超限与 Header 非法都以稳定错误拒绝。
 *
 * 字节写入使用 Uint8Array/DataView（无 Buffer 依赖），同一实现同时服务
 * Node Runtime 与浏览器 Stage（Phase 2 Browser Bundle Spike，ADR 0003）。
 */
export function encodeMediaFrame(frame: MediaFrame, limits: MediaFrameLimits = {}): Uint8Array {
  const maxHeaderBytes = limits.maxHeaderBytes ?? DEFAULT_MAX_MEDIA_HEADER_BYTES;
  const maxPayloadBytes = limits.maxPayloadBytes ?? DEFAULT_MAX_MEDIA_PAYLOAD_BYTES;
  const header = validateMediaFrameHeader(frame.header);
  const headerBytes = UTF8_ENCODER.encode(JSON.stringify(header));
  if (headerBytes.byteLength > maxHeaderBytes) {
    throw new MediaFrameError("header_too_large", "encoded header exceeds the configured limit");
  }
  if (frame.payload.byteLength > maxPayloadBytes) {
    throw new MediaFrameError("payload_too_large", "payload exceeds the configured limit");
  }
  const buffer = new Uint8Array(
    MEDIA_FRAME_PREFIX_BYTES + headerBytes.byteLength + frame.payload.byteLength,
  );
  buffer.set(MEDIA_MAGIC, 0);
  buffer[4] = MEDIA_FRAME_PROTOCOL_VERSION;
  buffer[5] = mediaKindToCode(frame.mediaKind);
  // flags v1 恒为 0（LE16），此处即两个零字节。
  buffer[6] = 0;
  buffer[7] = 0;
  const headerLength = headerBytes.byteLength;
  buffer[8] = headerLength & 0xff;
  buffer[9] = (headerLength >>> 8) & 0xff;
  buffer[10] = (headerLength >>> 16) & 0xff;
  buffer[11] = (headerLength >>> 24) & 0xff;
  buffer.set(headerBytes, MEDIA_FRAME_PREFIX_BYTES);
  buffer.set(frame.payload, MEDIA_FRAME_PREFIX_BYTES + headerBytes.byteLength);
  return buffer;
}
