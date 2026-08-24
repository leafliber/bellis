import { MediaFrameError } from "../errors.js";
import type { MediaErrorCode } from "../errors.js";
import type { MediaFrameHeader } from "@bellis/contracts";
import {
  MEDIA_FRAME_PREFIX_BYTES,
  MEDIA_FRAME_PROTOCOL_VERSION,
  MEDIA_MAGIC,
  DEFAULT_MAX_MEDIA_HEADER_BYTES,
  DEFAULT_MAX_MEDIA_PAYLOAD_BYTES,
  mediaKindFromCode,
  validateMediaFrameHeader,
} from "./frame-codec.js";
import type { MediaFrame, MediaFrameLimits } from "./frame-codec.js";

/**
 * 增量 Media 帧解析器（docs/phase-1-reference.md）。
 *
 * - 帧边界 = WebSocket 消息边界：适配器把一条 WS 二进制消息的任意分片
 *   依次 push，消息结束时调用 endMessage() 取得完整帧并复位累积器。
 *   布局没有 Payload 长度字段，因此分片本身无法自判帧结束。
 * - 累积器是预分配的有界缓冲（容量硬上限 = 12 + maxHeaderBytes +
 *   maxPayloadBytes，跨消息复用）：push 只做一次写入，没有逐分片 concat。
 * - **上限检查先于复制（分阶段）**：前缀未完整时只复制补齐前缀所需的
 *   ≤12 字节并解析真实 Header 长度；此后按精确上限
 *   （12 + headerLen + maxPayloadBytes）判定，越界分片零复制立即拒绝。
 *   即使配置了很大的 Header 上限，携带超限 Payload 的完整分片也不会
 *   被整体复制后再拒绝。
 * - Header 超限在读到长度字段时立即拒绝；Payload 超限在越界字节到达时
 *   立即拒绝；非法 Magic/版本/kind/Flags/UTF-8/JSON/Schema 稳定拒绝；
 *   消息在帧完成前结束（截断）同样拒绝。
 * - 失败后进入 failed 状态：后续 push/endMessage 一律拒绝，直到 reset()，
 *   绝不继续误读后续字节。
 * - push() 只做增量校验，返回值恒为空数组；帧在 endMessage() 产出。
 */

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const EMPTY_BUFFER = new Uint8Array(0);

export interface MediaFrameParserOptions extends MediaFrameLimits {}

interface PrefixFields {
  readonly mediaKindCode: number;
  readonly headerLength: number;
}

export class MediaFrameParser {
  readonly #maxHeaderBytes: number;
  readonly #maxPayloadBytes: number;
  /** 任何合法消息的字节数硬上限；也是缓冲容量的增长上界。 */
  readonly #absoluteMaxBytes: number;
  // Uint8Array（无 Buffer 依赖）：同一实现同时服务 Node 与浏览器 Stage
  // （Phase 2 Browser Bundle Spike，ADR 0003）。
  #buffer: Uint8Array = EMPTY_BUFFER;
  #length = 0;
  #prefix: PrefixFields | null = null;
  #header: MediaFrameHeader | null = null;
  #failed = false;

  constructor(options: MediaFrameParserOptions = {}) {
    const maxHeaderBytes = options.maxHeaderBytes ?? DEFAULT_MAX_MEDIA_HEADER_BYTES;
    const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_MEDIA_PAYLOAD_BYTES;
    if (!Number.isInteger(maxHeaderBytes) || maxHeaderBytes < 1) {
      throw new RangeError("maxHeaderBytes must be a positive integer");
    }
    if (!Number.isInteger(maxPayloadBytes) || maxPayloadBytes < 1) {
      throw new RangeError("maxPayloadBytes must be a positive integer");
    }
    this.#maxHeaderBytes = maxHeaderBytes;
    this.#maxPayloadBytes = maxPayloadBytes;
    this.#absoluteMaxBytes = MEDIA_FRAME_PREFIX_BYTES + maxHeaderBytes + maxPayloadBytes;
  }

  get failed(): boolean {
    return this.#failed;
  }

  /** 追加当前 WS 消息的一个分片；只做增量校验，恒返回空数组。 */
  push(chunk: Uint8Array): readonly MediaFrame[] {
    this.#guard();
    if (chunk.byteLength === 0) {
      return [];
    }
    // 前缀未完整时只复制补齐前缀所需的字节（≤12）：在得知真实 Header
    // 长度与精确上限之前，绝不复制分片的其余部分（配置很大的 Header
    // 上限时，一个携带超限 Payload 的完整分片也不做整体复制）。
    if (this.#length < MEDIA_FRAME_PREFIX_BYTES) {
      const need = Math.min(chunk.byteLength, MEDIA_FRAME_PREFIX_BYTES - this.#length);
      this.#ensureCapacity(this.#length + need);
      this.#buffer.set(chunk.subarray(0, need), this.#length);
      this.#length += need;
      this.#validateIncrementally();
      return this.#append(chunk.subarray(need));
    }
    return this.#append(chunk);
  }

  /** 前缀已完整（精确上限已知）：越界分片零复制直接拒绝。 */
  #append(chunk: Uint8Array): readonly MediaFrame[] {
    if (chunk.byteLength === 0) {
      return [];
    }
    const newLength = this.#length + chunk.byteLength;
    if (newLength > this.#currentCap()) {
      this.#fail("payload_too_large", "payload exceeds the configured limit");
    }
    this.#ensureCapacity(newLength);
    this.#buffer.set(chunk, this.#length);
    this.#length = newLength;
    this.#validateIncrementally();
    return [];
  }

  /** 当前 WS 消息结束：产出完整帧并复位；消息在帧完成前结束视为非法。 */
  endMessage(): readonly MediaFrame[] {
    this.#guard();
    if (this.#length < MEDIA_FRAME_PREFIX_BYTES) {
      this.#fail("truncated", "message ended before the frame prefix was complete");
    }
    this.#validateIncrementally();
    const prefix = this.#prefix;
    const header = this.#header;
    if (prefix === null || header === null) {
      this.#fail("truncated", "message ended before the header was complete");
    }
    const mediaKind = mediaKindFromCode(prefix.mediaKindCode);
    if (mediaKind === null) {
      this.#fail("invalid_media_kind", "unknown media kind byte");
    }
    const payloadStart = MEDIA_FRAME_PREFIX_BYTES + prefix.headerLength;
    const payload = Uint8Array.from(this.#buffer.subarray(payloadStart, this.#length));
    this.reset();
    return [{ header, payload, mediaKind }];
  }

  /** 复位累积进度与失败状态（缓冲保留复用；适配器在新 WS 消息开始时调用）。 */
  reset(): void {
    this.#length = 0;
    this.#prefix = null;
    this.#header = null;
    this.#failed = false;
  }

  #guard(): void {
    if (this.#failed) {
      throw new MediaFrameError("parser_failed", "parser is in failed state; call reset() first");
    }
  }

  #fail(code: MediaErrorCode, message: string): never {
    this.#failed = true;
    this.#length = 0;
    this.#prefix = null;
    this.#header = null;
    throw new MediaFrameError(code, message);
  }

  /** 前缀已知后收紧上限；未知时以绝对上限预判。 */
  #currentCap(): number {
    return this.#prefix === null
      ? this.#absoluteMaxBytes
      : MEDIA_FRAME_PREFIX_BYTES + this.#prefix.headerLength + this.#maxPayloadBytes;
  }

  /** 几何增长到硬上限为止的预分配缓冲；已复制内容随增长搬迁一次。 */
  #ensureCapacity(size: number): void {
    if (this.#buffer.byteLength >= size) {
      return;
    }
    let next = this.#buffer.byteLength === 0 ? 64 : this.#buffer.byteLength;
    while (next < size) {
      next *= 2;
    }
    // new Uint8Array 零初始化；已复制区间由 set() 覆写，读取只发生在
    // [0, #length) 内，语义与原 Buffer.allocUnsafe 路径一致。
    const grown = new Uint8Array(Math.min(next, this.#absoluteMaxBytes));
    grown.set(this.#buffer.subarray(0, this.#length), 0);
    this.#buffer = grown;
  }

  /** 尽可能早地校验前缀与 Header；Payload 越界在累积时立即拒绝。 */
  #validateIncrementally(): void {
    const buffer = this.#buffer;
    const length = this.#length;
    for (let index = 0; index < 4 && index < length; index += 1) {
      if (buffer[index] !== MEDIA_MAGIC[index]) {
        this.#fail("bad_magic", "frame does not start with the BELL magic");
      }
    }
    if (length >= 5 && buffer[4] !== MEDIA_FRAME_PROTOCOL_VERSION) {
      this.#fail("unsupported_version", "unsupported media frame protocol version");
    }
    if (length >= 6 && mediaKindFromCode(buffer[5] ?? 0) === null) {
      this.#fail("invalid_media_kind", "unknown media kind byte");
    }
    if (length >= 8) {
      const flags = (buffer[6] ?? 0) | ((buffer[7] ?? 0) << 8);
      if (flags !== 0) {
        this.#fail("bad_flags", "flags must be zero in protocol version 1");
      }
    }
    if (this.#prefix === null && length >= MEDIA_FRAME_PREFIX_BYTES) {
      const headerLength =
        ((buffer[8] ?? 0) |
          ((buffer[9] ?? 0) << 8) |
          ((buffer[10] ?? 0) << 16) |
          ((buffer[11] ?? 0) << 24)) >>>
        0;
      if (headerLength > this.#maxHeaderBytes) {
        this.#fail("header_too_large", "header length exceeds the configured limit");
      }
      this.#prefix = { mediaKindCode: buffer[5] ?? 0, headerLength };
    }
    if (this.#prefix !== null && this.#header === null) {
      const headerEnd = MEDIA_FRAME_PREFIX_BYTES + this.#prefix.headerLength;
      if (length >= headerEnd) {
        this.#header = this.#parseHeader(buffer.subarray(MEDIA_FRAME_PREFIX_BYTES, headerEnd));
      }
    }
    if (this.#prefix !== null && this.#header !== null) {
      const payloadBytes = length - MEDIA_FRAME_PREFIX_BYTES - this.#prefix.headerLength;
      if (payloadBytes > this.#maxPayloadBytes) {
        this.#fail("payload_too_large", "payload exceeds the configured limit");
      }
    }
  }

  /** 严格 UTF-8 → JSON → Header Schema；任何失败进入 failed 状态。 */
  #parseHeader(headerBytes: Uint8Array): MediaFrameHeader {
    let text: string;
    try {
      text = UTF8_DECODER.decode(headerBytes);
    } catch {
      this.#fail("invalid_utf8", "header is not valid UTF-8");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.#fail("invalid_json", "header is not valid JSON");
    }
    try {
      return validateMediaFrameHeader(parsed);
    } catch {
      this.#fail("invalid_header", "header does not match the media frame header schema");
    }
  }
}
