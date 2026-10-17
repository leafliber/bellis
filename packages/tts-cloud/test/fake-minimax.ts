import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';

/**
 * 本地假 MiniMax（双向流式 `t2a_v2_bidi` 的子集，按官方文档的事件与字段）：
 * connected_success → task_start/task_started → task_continue + task_flush → sentence_start、
 * task_continued（十六进制 16 位小端 PCM、word_streaming 字幕）、sentence_end、task_flushed；
 * task_cancel → task_canceled；空闲超时以 2201 断开。只用于测试，不连接任何真实端点。
 */
export interface FakeMinimaxOptions {
  apiKey: string;
  sampleRate?: number;
  /** 每个码点的采样数。 */
  samplesPerChar?: number;
  /** 每段音频含几个码点。 */
  chunkChars?: number;
  /** 两段音频之间的间隔。 */
  chunkDelayMs?: number;
  /** 在“，”处拆成多个句子（每句的字幕时间从 0 起算）。 */
  splitSentences?: boolean;
  /** 把每段音频的字节在奇数处拆成两条消息。 */
  oddChunks?: boolean;
  /** task_start 以这个错误码失败。 */
  failStart?: number;
  /** 第一次 task_continue 以 2205 拒绝。 */
  backpressureOnce?: boolean;
  /** task_continue 以这个错误码拒绝（例如 2204）。 */
  rejectText?: number;
  /** 合成到第几段音频时以 task_failed 中断。 */
  failAtChunk?: { index: number; code: number };
  /** 空闲这么久后以 2201 断开。 */
  idleCloseMs?: number;
  /** 收到取消后仍发出的音频段数。 */
  audioAfterCancel?: number;
  /** 收到取消后不确认。 */
  ignoreCancel?: boolean;
  /** 不发送 task_flushed。 */
  neverFlush?: boolean;
  /** 收到 task_flush 后什么也不发（模拟服务端卡住）。 */
  mute?: boolean;
}

export interface Received {
  connection: number;
  event: string;
  text?: string;
}

/** 第 i 个码点的采样值：便于核对解码结果。 */
export function sampleValue(char: number): number {
  return ((char + 1) * 1000) % 30_000;
}

export class FakeMinimax {
  readonly received: Received[] = [];
  readonly taskStarts: Array<Record<string, unknown>> = [];
  readonly authorizations: string[] = [];
  connections = 0;
  pings = 0;
  readonly #server: WebSocketServer;
  readonly #options: Required<
    Omit<FakeMinimaxOptions, 'failStart' | 'rejectText' | 'failAtChunk' | 'idleCloseMs'>
  > &
    FakeMinimaxOptions;
  readonly #sockets = new Set<WebSocket>();

  private constructor(options: FakeMinimaxOptions) {
    this.#options = {
      sampleRate: 8000,
      samplesPerChar: 80,
      chunkChars: 2,
      chunkDelayMs: 5,
      splitSentences: false,
      oddChunks: false,
      backpressureOnce: false,
      audioAfterCancel: 0,
      ignoreCancel: false,
      neverFlush: false,
      mute: false,
      ...options,
    };
    this.#server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: (info, done) => {
        const auth = String(info.req.headers.authorization ?? '');
        this.authorizations.push(auth);
        if (auth === `Bearer ${this.#options.apiKey}`) done(true);
        else done(false, 401, 'Unauthorized');
      },
    });
    this.#server.on('connection', (socket) => this.#accept(socket));
  }

  static async start(options: FakeMinimaxOptions): Promise<FakeMinimax> {
    const fake = new FakeMinimax(options);
    await once(fake.#server, 'listening');
    return fake;
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.#server.address() as AddressInfo).port}/ws/v1/t2a_v2_bidi`;
  }

  events(name: string): Received[] {
    return this.received.filter((r) => r.event === name);
  }

  /** 断开全部连接（模拟网络中断）。 */
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
    const send = (message: Record<string, unknown>) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };
    const ok = { status_code: 0, status_msg: 'success' };
    let buffer = '';
    let started = false;
    let canceled = false;
    let synthesizing = false;
    let rejectedOnce = false;
    let idle: NodeJS.Timeout | undefined;
    const touch = () => {
      if (idle) clearTimeout(idle);
      if (o.idleCloseMs === undefined) return;
      idle = setTimeout(() => {
        send({
          event: 'task_failed',
          base_resp: { status_code: 2201, status_msg: 'idle timeout' },
        });
        socket.close();
      }, o.idleCloseMs);
    };
    socket.on('close', () => {
      if (idle) clearTimeout(idle);
    });
    socket.on('ping', () => {
      this.pings += 1;
      touch();
    });

    const synthesize = async (text: string) => {
      synthesizing = true;
      const sentences = o.splitSentences
        ? text.split(/(?<=，)/u).filter((s) => s.length > 0)
        : [text];
      let chunkIndex = 0;
      let extra = o.audioAfterCancel;
      for (const sentence of sentences) {
        send({ event: 'sentence_start', base_resp: ok });
        const chars = [...sentence];
        const msPerChar = (o.samplesPerChar * 1000) / o.sampleRate;
        for (let at = 0; at < chars.length; at += o.chunkChars) {
          if (canceled) {
            if (extra <= 0) break;
            extra -= 1;
          }
          if (o.failAtChunk && chunkIndex === o.failAtChunk.index) {
            send({
              event: 'task_failed',
              base_resp: { status_code: o.failAtChunk.code, status_msg: 'failed' },
            });
            socket.close();
            return;
          }
          chunkIndex += 1;
          const part = chars.slice(at, at + o.chunkChars);
          const bytes = Buffer.alloc(part.length * o.samplesPerChar * 2);
          part.forEach((_, k) => {
            for (let s = 0; s < o.samplesPerChar; s += 1) {
              bytes.writeInt16LE(sampleValue(at + k), (k * o.samplesPerChar + s) * 2);
            }
          });
          const subtitle = {
            text: sentence,
            text_begin: 0,
            text_end: chars.length,
            time_begin: 0,
            time_end: (at + part.length) * msPerChar,
            timestamped_words: chars.slice(0, at + part.length).map((word, i) => ({
              word,
              word_begin: i,
              word_end: i + 1,
              time_begin: i * msPerChar,
              time_end: (i + 1) * msPerChar,
            })),
          };
          const extraInfo = {
            audio_sample_rate: o.sampleRate,
            audio_format: 'pcm',
            audio_channel: 1,
          };
          if (o.oddChunks) {
            const cut = 3;
            send({
              event: 'task_continued',
              base_resp: ok,
              data: { audio: bytes.subarray(0, cut).toString('hex') },
              extra_info: extraInfo,
              is_final: false,
            });
            send({
              event: 'task_continued',
              base_resp: ok,
              data: { audio: bytes.subarray(cut).toString('hex'), subtitle },
              extra_info: extraInfo,
              is_final: false,
            });
          } else {
            send({
              event: 'task_continued',
              base_resp: ok,
              data: { audio: bytes.toString('hex'), subtitle },
              extra_info: extraInfo,
              is_final: false,
            });
          }
          await new Promise((resolve) => setTimeout(resolve, o.chunkDelayMs));
        }
        if (canceled) break;
        send({ event: 'sentence_end', base_resp: ok });
      }
      synthesizing = false;
      if (canceled) {
        canceled = false;
        if (!o.ignoreCancel) send({ event: 'task_canceled', base_resp: ok });
        return;
      }
      if (!o.neverFlush) send({ event: 'task_flushed', base_resp: ok });
    };

    socket.on('message', (data) => {
      touch();
      const message = JSON.parse(String(data)) as { event: string; text?: string };
      this.received.push({
        connection: id,
        event: message.event,
        ...(message.text === undefined ? {} : { text: message.text }),
      });
      switch (message.event) {
        case 'task_start':
          if (started) {
            send({
              event: 'task_failed',
              base_resp: { status_code: 2206, status_msg: 'repeated' },
            });
            socket.close();
            return;
          }
          this.taskStarts.push(message);
          if (o.failStart !== undefined) {
            send({
              event: 'task_failed',
              base_resp: { status_code: o.failStart, status_msg: 'no' },
            });
            socket.close();
            return;
          }
          started = true;
          send({ event: 'task_started', base_resp: ok });
          return;
        case 'task_continue':
          if (o.backpressureOnce && !rejectedOnce) {
            rejectedOnce = true;
            send({ event: 'task_continued', base_resp: { status_code: 2205, status_msg: 'busy' } });
            return;
          }
          if (o.rejectText !== undefined) {
            send({
              event: 'task_continued',
              base_resp: { status_code: o.rejectText, status_msg: 'rejected' },
            });
            return;
          }
          buffer += message.text ?? '';
          return;
        case 'task_flush': {
          if (o.mute) return;
          const text = buffer;
          buffer = '';
          if (!text) {
            send({ event: 'task_flushed', base_resp: ok });
            return;
          }
          void synthesize(text);
          return;
        }
        case 'task_cancel':
          buffer = '';
          if (synthesizing) canceled = true;
          else if (!o.ignoreCancel) send({ event: 'task_canceled', base_resp: ok });
          return;
        case 'task_finish':
          send({ event: 'task_finished', base_resp: ok });
          socket.close();
          return;
      }
    });
    send({
      session_id: `s${id}`,
      event: 'connected_success',
      trace_id: 't',
      base_resp: ok,
      connect_id: `c${id}`,
    });
    touch();
  }
}
