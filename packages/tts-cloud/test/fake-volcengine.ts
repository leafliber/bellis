import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';

/**
 * 本地假火山引擎（V3 双向流式的子集）。帧的编解码按官方文档的字节表独立实现，
 * 不复用被测的编解码，两边的错误不会互相抵消。只用于测试，不连接任何真实端点。
 */
export interface FakeVolcengineOptions {
  /** 新版控制台的 API Key；给出 appId/accessToken 时按旧版控制台鉴权。 */
  apiKey?: string | undefined;
  appId?: string;
  accessToken?: string;
  sampleRate?: number;
  samplesPerChar?: number;
  chunkChars?: number;
  chunkDelayMs?: number;
  /** 时间戳的返回方式：随 TTSSentenceEnd（TTS 1.0）或用文档未列编号的字幕事件（TTS 2.0）。 */
  timestamps?: 'sentence-end' | 'subtitle-event';
  /** 建连后以 ConnectionFailed 拒绝。 */
  connectionFailed?: boolean;
  /** StartSession 以 SessionFailed 回应。 */
  sessionFailed?: boolean;
  /** 每句之前先发一帧别的会话的音频（应被丢弃）。 */
  staleFrames?: boolean;
  /** 收到取消后仍发出的音频段数。 */
  audioAfterCancel?: number;
}

/** 文档未列出 TTSSubtitle 的编号；假服务器随便用一个，验证适配器按载荷识别时间戳。 */
export const FAKE_SUBTITLE_EVENT = 363;

export function sampleValue(char: number): number {
  return ((char + 1) * 700) % 30_000;
}

interface ClientFrame {
  event: number;
  sessionId: string | undefined;
  payload: Record<string, unknown>;
}

/** 按文档解析客户端的 Full-client request 帧。 */
function decodeClient(data: Buffer): ClientFrame {
  if (data[0] !== 0x11) throw new Error('版本或头长不对');
  if ((data[1] as number) >> 4 !== 0b0001 || ((data[1] as number) & 0x0f) !== 0b0100) {
    throw new Error('不是带事件号的 Full-client request');
  }
  if (data[2] !== 0x10 || data[3] !== 0) throw new Error('序列化或压缩不对');
  const event = data.readInt32BE(4);
  let offset = 8;
  let sessionId: string | undefined;
  if (event >= 100) {
    const size = data.readUInt32BE(offset);
    sessionId = data.subarray(offset + 4, offset + 4 + size).toString('utf8');
    offset += 4 + size;
  }
  const size = data.readUInt32BE(offset);
  const body = data.subarray(offset + 4, offset + 4 + size);
  if (offset + 4 + size !== data.length) throw new Error('长度不符');
  return {
    event,
    sessionId,
    payload: JSON.parse(body.toString('utf8')) as Record<string, unknown>,
  };
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value);
  return b;
}

function i32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(value);
  return b;
}

/** 服务端帧：类型 0b1001（JSON）或 0b1011（音频），带事件号与 ID。 */
function serverFrame(
  type: number,
  event: number,
  id: string,
  payload: Buffer,
  json: boolean,
): Buffer {
  const idBytes = Buffer.from(id, 'utf8');
  return Buffer.concat([
    Buffer.from([0x11, (type << 4) | 0b0100, json ? 0x10 : 0x00, 0]),
    i32(event),
    u32(idBytes.length),
    idBytes,
    u32(payload.length),
    payload,
  ]);
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');

export class FakeVolcengine {
  readonly received: Array<{
    connection: number;
    event: number;
    sessionId?: string;
    text?: string;
  }> = [];
  readonly sessions: Array<Record<string, unknown>> = [];
  readonly headers: Array<Record<string, string | string[] | undefined>> = [];
  connections = 0;
  readonly #server: WebSocketServer;
  readonly #options: FakeVolcengineOptions & {
    sampleRate: number;
    samplesPerChar: number;
    chunkChars: number;
    chunkDelayMs: number;
    timestamps: 'sentence-end' | 'subtitle-event';
    audioAfterCancel: number;
  };
  readonly #sockets = new Set<WebSocket>();

  private constructor(options: FakeVolcengineOptions) {
    this.#options = {
      sampleRate: 8000,
      samplesPerChar: 80,
      chunkChars: 2,
      chunkDelayMs: 5,
      timestamps: 'sentence-end',
      audioAfterCancel: 0,
      ...options,
    };
    this.#server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: (info, done) => {
        const h = info.req.headers;
        this.headers.push({ ...h });
        const o = this.#options;
        const ok =
          typeof h['x-api-resource-id'] === 'string' &&
          (o.apiKey !== undefined
            ? h['x-api-key'] === o.apiKey
            : h['x-api-app-id'] === o.appId && h['x-api-access-key'] === o.accessToken);
        if (ok) done(true);
        else done(false, 401, 'Unauthorized');
      },
    });
    this.#server.on('connection', (socket) => this.#accept(socket));
  }

  static async start(options: FakeVolcengineOptions): Promise<FakeVolcengine> {
    const fake = new FakeVolcengine(options);
    await once(fake.#server, 'listening');
    return fake;
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.#server.address() as AddressInfo).port}/api/v3/tts/bidirection`;
  }

  events(event: number): Array<{ connection: number; event: number }> {
    return this.received.filter((r) => r.event === event);
  }

  drop(): void {
    for (const socket of this.#sockets) socket.terminate();
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.terminate();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #accept(socket: WebSocket): void {
    this.connections += 1;
    const id = this.connections;
    this.#sockets.add(socket);
    socket.on('close', () => this.#sockets.delete(socket));
    const o = this.#options;
    const send = (frame: Buffer) => {
      if (socket.readyState === socket.OPEN) socket.send(frame);
    };
    const sessions = new Map<string, { text: string; canceled: boolean; running: boolean }>();

    const synthesize = async (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.running = true;
      const chars = [...session.text];
      const sec = o.samplesPerChar / o.sampleRate;
      const words = chars.map((word, i) => ({
        word,
        startTime: i * sec,
        endTime: (i + 1) * sec,
        confidence: 0.9,
      }));
      if (o.staleFrames) {
        send(serverFrame(0b1011, 352, 'other-session', Buffer.alloc(16), false));
      }
      send(serverFrame(0b1001, 350, sessionId, json({ phonemes: [], text: '', words: [] }), true));
      let extra = o.audioAfterCancel;
      for (let at = 0; at < chars.length; at += o.chunkChars) {
        if (session.canceled) {
          if (extra <= 0) break;
          extra -= 1;
        }
        const part = chars.slice(at, at + o.chunkChars);
        const bytes = Buffer.alloc(part.length * o.samplesPerChar * 2);
        part.forEach((_, k) => {
          for (let s = 0; s < o.samplesPerChar; s += 1) {
            bytes.writeInt16LE(sampleValue(at + k), (k * o.samplesPerChar + s) * 2);
          }
        });
        send(serverFrame(0b1011, 352, sessionId, bytes, false));
        if (o.timestamps === 'subtitle-event') {
          send(
            serverFrame(
              0b1001,
              FAKE_SUBTITLE_EVENT,
              sessionId,
              json({ text: session.text, words: words.slice(at, at + part.length) }),
              true,
            ),
          );
        }
        await new Promise((resolve) => setTimeout(resolve, o.chunkDelayMs));
      }
      session.running = false;
      if (session.canceled) {
        send(
          serverFrame(0b1001, 151, sessionId, json({ status_code: 20000000, message: 'ok' }), true),
        );
        return;
      }
      send(
        serverFrame(
          0b1001,
          351,
          sessionId,
          json({
            phonemes: [],
            text: session.text,
            words: o.timestamps === 'sentence-end' ? words : [],
          }),
          true,
        ),
      );
      send(
        serverFrame(
          0b1001,
          152,
          sessionId,
          json({ status_code: 20000000, message: 'ok', usage: { text_words: chars.length } }),
          true,
        ),
      );
    };

    socket.on('message', (data, binary) => {
      if (!binary) return;
      const frame = decodeClient(data as Buffer);
      const text = (frame.payload.req_params as { text?: string } | undefined)?.text;
      this.received.push({
        connection: id,
        event: frame.event,
        ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
        ...(text === undefined ? {} : { text }),
      });
      const sessionId = frame.sessionId ?? '';
      switch (frame.event) {
        case 1:
          if (o.connectionFailed) {
            // 文档的 ConnectionFailed 示例：连接 ID 之后是 JSON 的 status_code 与 message。
            send(
              serverFrame(
                0b1001,
                51,
                `conn-${id}`,
                json({ status_code: 45000000, message: 'unauthorized' }),
                true,
              ),
            );
            socket.close();
            return;
          }
          send(serverFrame(0b1001, 50, `conn-${id}`, json({}), true));
          return;
        case 2:
          send(serverFrame(0b1001, 52, `conn-${id}`, json({}), true));
          socket.close();
          return;
        case 100:
          this.sessions.push(frame.payload);
          if (o.sessionFailed) {
            send(
              serverFrame(
                0b1001,
                153,
                sessionId,
                json({ status_code: 55000001, message: 'session error' }),
                true,
              ),
            );
            return;
          }
          sessions.set(sessionId, { text: '', canceled: false, running: false });
          send(serverFrame(0b1001, 150, sessionId, json({}), true));
          return;
        case 200: {
          const session = sessions.get(sessionId);
          if (session) session.text += text ?? '';
          return;
        }
        case 102:
          void synthesize(sessionId);
          return;
        case 101: {
          const session = sessions.get(sessionId);
          if (!session) return;
          if (session.running) session.canceled = true;
          else
            send(
              serverFrame(
                0b1001,
                151,
                sessionId,
                json({ status_code: 20000000, message: 'ok' }),
                true,
              ),
            );
          return;
        }
      }
    });
  }
}

/** 错误帧（类型 0b1111）：错误码、负载长度、JSON 负载。 */
export function errorFrame(code: number, message: string): Buffer {
  const payload = json({ error: message });
  return Buffer.concat([
    Buffer.from([0x11, 0xf0, 0x10, 0]),
    u32(code),
    u32(payload.length),
    payload,
  ]);
}
