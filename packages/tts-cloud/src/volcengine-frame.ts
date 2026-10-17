import { gunzipSync } from 'node:zlib';

/**
 * 火山引擎（豆包语音）V3 WebSocket 二进制协议的编解码，按官方文档“WebSocket 双向流式-V3”：
 * https://docs.volcengine.com/docs/6561/1329505
 *
 * 帧 = 4 字节头 + 可选字段 + 4 字节负载长度 + 负载；整数一律大端。
 * - 头：版本 0b0001、头长 0b0001（4 字节）；消息类型与标志；序列化（0 原始、1 JSON）与压缩（0 无、1 gzip）；保留字节。
 * - 标志 0b0100 表示带 4 字节事件号。连接类事件（1、2、50–52）随后是连接 ID（服务端下发时），
 *   会话类与数据类事件随后是 4 字节长度加会话 ID。
 * - 错误帧（类型 0b1111）在头之后是 4 字节错误码，然后是负载长度与 JSON 负载。
 */
export const MessageType = {
  FullClientRequest: 0b0001,
  FullServerResponse: 0b1001,
  AudioOnlyServer: 0b1011,
  Error: 0b1111,
} as const;

export const Event = {
  StartConnection: 1,
  FinishConnection: 2,
  ConnectionStarted: 50,
  ConnectionFailed: 51,
  ConnectionFinished: 52,
  StartSession: 100,
  CancelSession: 101,
  FinishSession: 102,
  SessionStarted: 150,
  SessionCanceled: 151,
  SessionFinished: 152,
  SessionFailed: 153,
  TaskRequest: 200,
  TTSSentenceStart: 350,
  TTSSentenceEnd: 351,
  TTSResponse: 352,
} as const;

const WITH_EVENT = 0b0100;
const JSON_SERIALIZATION = 0b0001;
const GZIP = 0b0001;
const HEADER = 0x11;

/** 连接类事件：没有会话 ID。 */
function connectionEvent(event: number): boolean {
  return event < 100;
}

/** 客户端请求帧（Full-client request，JSON，不压缩，带事件号）。 */
export function encodeRequest(event: number, payload: unknown, sessionId?: string): Uint8Array {
  const body = Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
  const parts: Buffer[] = [
    Buffer.from([
      HEADER,
      (MessageType.FullClientRequest << 4) | WITH_EVENT,
      JSON_SERIALIZATION << 4,
      0,
    ]),
  ];
  const eventBytes = Buffer.alloc(4);
  eventBytes.writeInt32BE(event);
  parts.push(eventBytes);
  if (!connectionEvent(event)) {
    if (sessionId === undefined) throw new Error(`事件 ${event} 需要会话 ID`);
    const id = Buffer.from(sessionId, 'utf8');
    const size = Buffer.alloc(4);
    size.writeUInt32BE(id.length);
    parts.push(size, id);
  }
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length);
  parts.push(size, body);
  return Buffer.concat(parts);
}

export interface ServerFrame {
  type: number;
  event: number | undefined;
  /** 会话 ID 或连接 ID。 */
  id: string | undefined;
  /** 错误帧的错误码。 */
  errorCode: number | undefined;
  serialization: number;
  payload: Buffer;
}

class Reader {
  readonly data: Buffer;
  offset: number;
  constructor(data: Buffer, start: number) {
    this.data = data;
    this.offset = start;
  }
  get left(): number {
    return this.data.length - this.offset;
  }
  int32(): number {
    if (this.left < 4) throw new Error('帧太短');
    const value = this.data.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }
  uint32(): number {
    if (this.left < 4) throw new Error('帧太短');
    const value = this.data.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }
  bytes(length: number): Buffer {
    if (this.left < length) throw new Error('帧长度不符');
    const value = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
}

/** 先读 ID 再读负载；整帧恰好读完才算成立。 */
function idThenPayload(data: Buffer, start: number): { id: string; payload: Buffer } | undefined {
  try {
    const reader = new Reader(data, start);
    const id = reader.bytes(reader.uint32()).toString('utf8');
    const payload = reader.bytes(reader.uint32());
    return reader.left === 0 ? { id, payload } : undefined;
  } catch {
    return undefined;
  }
}

function payloadOnly(data: Buffer, start: number): Buffer | undefined {
  try {
    const reader = new Reader(data, start);
    const payload = reader.bytes(reader.uint32());
    return reader.left === 0 ? payload : undefined;
  } catch {
    return undefined;
  }
}

/** 解析服务端帧；格式不符时抛错。 */
export function decodeFrame(data: Buffer): ServerFrame {
  if (data.length < 4) throw new Error('帧太短');
  const headerSize = (data[0] as number) & 0x0f;
  const type = (data[1] as number) >> 4;
  const flags = (data[1] as number) & 0x0f;
  const serialization = (data[2] as number) >> 4;
  const compression = (data[2] as number) & 0x0f;
  const start = headerSize * 4;
  if (headerSize < 1 || data.length < start) throw new Error('帧头不合法');
  const reader = new Reader(data, start);
  let event: number | undefined;
  let id: string | undefined;
  let errorCode: number | undefined;
  let payload: Buffer;
  if (type === MessageType.Error) {
    errorCode = reader.uint32();
    payload = payloadOnly(data, reader.offset) ?? reader.bytes(reader.left);
  } else {
    if (flags & WITH_EVENT) event = reader.int32();
    // 连接类事件的连接 ID 是否出现，文档的示例前后不一（ConnectionFailed）；按整帧能否恰好读完判断。
    const withId = idThenPayload(data, reader.offset);
    if (withId) {
      id = withId.id;
      payload = withId.payload;
    } else {
      const only = payloadOnly(data, reader.offset);
      if (!only) throw new Error('帧长度不符');
      payload = only;
    }
  }
  if (compression === GZIP) payload = gunzipSync(payload);
  return { type, event, id, errorCode, serialization, payload };
}

/** 把 JSON 负载解析成对象；不是 JSON 或解析失败时返回 undefined。 */
export function jsonPayload(frame: ServerFrame): Record<string, unknown> | undefined {
  if (frame.serialization !== JSON_SERIALIZATION || frame.payload.length === 0) return undefined;
  try {
    const value: unknown = JSON.parse(frame.payload.toString('utf8'));
    return value !== null && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
