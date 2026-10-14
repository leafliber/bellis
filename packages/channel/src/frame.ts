import { ChannelError } from './errors.ts';

/**
 * 帧格式：4 字节大端负载长度 + 1 字节类型 + 负载。
 * 握手帧只在认证前出现；认证后只允许 JSON 帧与二进制帧。
 */
export const FrameKind = { Handshake: 0, Json: 1, Binary: 2 } as const;
export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

export interface Frame {
  kind: FrameKind;
  payload: Buffer;
}

export const FRAME_HEADER_BYTES = 5;

function isFrameKind(value: number): value is FrameKind {
  return value === FrameKind.Handshake || value === FrameKind.Json || value === FrameKind.Binary;
}

export function encodeFrame(kind: FrameKind, payload: Uint8Array): Buffer {
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  frame.writeUInt8(kind, 4);
  frame.set(payload, FRAME_HEADER_BYTES);
  return frame;
}

/**
 * 增量解帧。每次 `read()` 只取一帧，以便调用方在两帧之间调整长度上限
 * （认证前用很小的上限，避免未认证的对端占用内存）。
 */
export class FrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);
  #maxPayloadBytes: number;

  constructor(maxPayloadBytes: number) {
    this.#maxPayloadBytes = maxPayloadBytes;
  }

  set maxPayloadBytes(value: number) {
    this.#maxPayloadBytes = value;
  }

  get bufferedBytes(): number {
    return this.#buffer.length;
  }

  push(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
  }

  /** 取出下一帧；数据不足时返回 undefined，帧头非法时抛出 ChannelError。 */
  read(): Frame | undefined {
    if (this.#buffer.length < FRAME_HEADER_BYTES) return undefined;
    const length = this.#buffer.readUInt32BE(0);
    const kind = this.#buffer.readUInt8(4);
    if (!isFrameKind(kind)) {
      throw new ChannelError('protocol-error', `未知的帧类型 ${kind}`);
    }
    if (length > this.#maxPayloadBytes) {
      throw new ChannelError('frame-too-large', `帧长 ${length} 超过上限 ${this.#maxPayloadBytes}`);
    }
    const end = FRAME_HEADER_BYTES + length;
    if (this.#buffer.length < end) return undefined;
    const payload = this.#buffer.subarray(FRAME_HEADER_BYTES, end);
    this.#buffer = this.#buffer.subarray(end);
    return { kind, payload };
  }
}
