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
  /** 收到的块按序排队，只在凑齐帧头或整帧时合并一次，避免分片到达时反复复制已缓冲的前缀。 */
  #chunks: Buffer[] = [];
  #buffered = 0;
  #maxPayloadBytes: number;

  constructor(maxPayloadBytes: number) {
    this.#maxPayloadBytes = maxPayloadBytes;
  }

  set maxPayloadBytes(value: number) {
    this.#maxPayloadBytes = value;
  }

  get bufferedBytes(): number {
    return this.#buffered;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.#chunks.push(chunk);
    this.#buffered += chunk.length;
  }

  /** 取出下一帧；数据不足时返回 undefined，帧头非法时抛出 ChannelError。 */
  read(): Frame | undefined {
    if (this.#buffered < FRAME_HEADER_BYTES) return undefined;
    const head = this.#coalesce(FRAME_HEADER_BYTES);
    const length = head.readUInt32BE(0);
    const kind = head.readUInt8(4);
    if (!isFrameKind(kind)) {
      throw new ChannelError('protocol-error', `未知的帧类型 ${kind}`);
    }
    if (length > this.#maxPayloadBytes) {
      throw new ChannelError('frame-too-large', `帧长 ${length} 超过上限 ${this.#maxPayloadBytes}`);
    }
    const end = FRAME_HEADER_BYTES + length;
    if (this.#buffered < end) return undefined;
    const block = this.#coalesce(end);
    const payload = block.subarray(FRAME_HEADER_BYTES, end);
    if (block.length === end) this.#chunks.shift();
    else this.#chunks[0] = block.subarray(end);
    this.#buffered -= end;
    return { kind, payload };
  }

  /** 让第一个块至少包含 n 个字节（调用方保证已缓冲的字节数不少于 n），返回第一个块。 */
  #coalesce(n: number): Buffer {
    const first = this.#chunks[0] as Buffer;
    if (first.length >= n) return first;
    let count = 0;
    let total = 0;
    while (total < n) {
      total += (this.#chunks[count] as Buffer).length;
      count += 1;
    }
    const merged = Buffer.concat(this.#chunks.slice(0, count), total);
    this.#chunks.splice(0, count, merged);
    return merged;
  }
}
