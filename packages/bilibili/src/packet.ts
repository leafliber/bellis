import { brotliDecompressSync, inflateSync } from 'node:zlib';

/**
 * 开放平台长连接的包：16 字节大端包头（PacketLen u32、HeaderLen u16、Version u16、Operation u32、Seq u32）
 * 加正文。一条 WebSocket 消息里可能连着多个包。
 */
export interface Packet {
  version: number;
  operation: number;
  sequence: number;
  body: Buffer;
}

export const HEADER_LENGTH = 16;

export const Operation = {
  Heartbeat: 2,
  HeartbeatReply: 3,
  Message: 5,
  Auth: 7,
  AuthReply: 8,
} as const;

export const Version = {
  /** 正文是 JSON 原文。 */
  Raw: 0,
  /**
   * 客户端发出的包（认证、心跳）写的版本。官方文档只说明了 0 与 2 的含义；blivedm 与 bianka 发出的包都写 1，
   * 这里与之一致（真机核对前 PENDING）。收到的包按原文处理。
   */
  Client: 1,
  /** 正文是 zlib 压缩过的一串完整的包。 */
  Zlib: 2,
  /** 正文是 brotli 压缩过的一串完整的包（官方文档未写，社区实现有处理，PENDING）。 */
  Brotli: 3,
} as const;

/** 解压后的上限：一条消息里的批量包远小于这个值，超过就当作错误，免得被压缩炸弹拖垮。 */
export const MAX_INFLATED_BYTES = 8 * 1024 * 1024;
/** 压缩包里再套压缩包的层数上限。 */
const MAX_DEPTH = 4;

export class PacketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PacketError';
  }
}

export function encodePacket(
  operation: number,
  body: Uint8Array | string = '',
  version: number = Version.Client,
  sequence = 1,
): Buffer {
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
  const header = Buffer.alloc(HEADER_LENGTH);
  header.writeUInt32BE(HEADER_LENGTH + payload.length, 0);
  header.writeUInt16BE(HEADER_LENGTH, 4);
  header.writeUInt16BE(version, 6);
  header.writeUInt32BE(operation, 8);
  header.writeUInt32BE(sequence, 12);
  return Buffer.concat([header, payload]);
}

function inflate(packet: Packet): Buffer {
  try {
    return packet.version === Version.Zlib
      ? inflateSync(packet.body, { maxOutputLength: MAX_INFLATED_BYTES })
      : brotliDecompressSync(packet.body, { maxOutputLength: MAX_INFLATED_BYTES });
  } catch (error) {
    const how = packet.version === Version.Zlib ? 'zlib' : 'brotli';
    throw new PacketError(`${how} 解压失败：${(error as Error).message}`);
  }
}

/**
 * 拆开一条消息里的全部包；Version 为 2（zlib）或 3（brotli）的包解压后按同样的格式递归拆开，
 * 返回的都是不再压缩的包。格式不对时抛 {@link PacketError}。
 */
export function decodePackets(data: Uint8Array, depth = 0): Packet[] {
  if (depth > MAX_DEPTH) throw new PacketError('压缩嵌套过深');
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < HEADER_LENGTH) throw new PacketError('包头不完整');
    const length = buffer.readUInt32BE(offset);
    const headerLength = buffer.readUInt16BE(offset + 4);
    if (headerLength < HEADER_LENGTH) throw new PacketError(`包头长度 ${headerLength} 小于 16`);
    if (length < headerLength) throw new PacketError(`包长 ${length} 小于包头长度`);
    if (offset + length > buffer.length) throw new PacketError(`包长 ${length} 超出消息`);
    const packet: Packet = {
      version: buffer.readUInt16BE(offset + 6),
      operation: buffer.readUInt32BE(offset + 8),
      sequence: buffer.readUInt32BE(offset + 12),
      body: buffer.subarray(offset + headerLength, offset + length),
    };
    if (packet.version === Version.Zlib || packet.version === Version.Brotli) {
      packets.push(...decodePackets(inflate(packet), depth + 1));
    } else {
      packets.push(packet);
    }
    offset += length;
  }
  return packets;
}
