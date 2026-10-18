import type { TimerHandle } from '@bellis/kernel';
import type { WordStamp } from '@bellis/speech';
import {
  aborted,
  type Engine,
  type EngineEnv,
  EngineError,
  type EngineStream,
  type EngineTimeouts,
  emptyStream,
  Job,
  MAX_MESSAGE_BYTES,
  PcmDecoder,
  RequestError,
  redact,
  Serial,
} from './engine.ts';
import { Link } from './link.ts';

/**
 * MiniMax 双向流式语音合成（`/ws/v1/t2a_v2_bidi`）的适配器。协议以官方文档为准：
 * https://platform.minimax.io/docs/api-reference/speech-t2a-websocket-bidi.md （国际）、
 * https://platform.minimax.cn/docs/api-reference/speech-t2a-websocket-bidi.md （中国大陆）。
 *
 * - 建连带 `Authorization: Bearer <API Key>`，收到 `connected_success` 后发 `task_start`，
 *   收到 `task_started` 后会话可用；一条连接只有一个会话，多句复用。
 * - 每句发 `task_continue`（文本）与 `task_flush`；音频（十六进制 PCM）与字幕随 `task_continued` 到达，
 *   `task_flushed` 表示这一句的音频已全部发出。
 * - 取消发 `task_cancel`，收到 `task_canceled` 后会话回到可用状态。被取消的 flush 仍会确认：
 *   `task_flushed` 紧跟在 `task_canceled` 之后到达（S-07 实测）。等这些确认到齐才把连接留给下一句，
 *   免得迟到的确认被当成下一句的结束；取消的截止时间内没到齐就断开，下一句重新建连。
 * - 字幕的时间与文本偏移相对当前句（`sentence_start` 到 `sentence_end`）从 0 起算；时间戳按 `sentence_start`
 *   时已收到的采样数换算成相对整句音频开头的毫秒，文本按字词本身与朗读文本对照，不用厂商的字符偏移。
 * - 约 120 秒无活动服务端以 2201 断开，且不主动 ping：空闲时客户端定时 ping，空闲过久主动断开。
 */
export interface MinimaxOptions {
  endpoint: string;
  model: string;
  voiceId: string;
  sampleRate: number;
  speed: number;
  vol: number;
  pitch: number;
  /** 空串表示由模型自动判断。 */
  emotion: string;
  /** 空串表示不指定。 */
  languageBoost: string;
  subtitleType: 'word_streaming' | 'word' | 'sentence';
  pingIntervalMs: number;
}

interface Subtitle {
  text?: string;
  text_begin?: number;
  time_begin?: number;
  time_end?: number;
  timestamped_words?: Array<{ word?: string; time_begin?: number; time_end?: number }> | null;
}

interface Message {
  event?: string;
  base_resp?: { status_code?: number; status_msg?: string };
  data?: { audio?: string; subtitle?: Subtitle | null } | null;
  extra_info?: {
    audio_sample_rate?: number;
    audio_length?: number;
    audio_size?: number;
    audio_format?: string;
    audio_channel?: number;
    usage_characters?: number;
  } | null;
  is_final?: boolean;
}

interface Connection {
  link: Link;
  secret: string;
  /** 当前的接收者：建连握手或一句合成；空闲时为 undefined。 */
  handler: ((message: Message) => void) | undefined;
  onGone: ((reason: string) => void) | undefined;
  idle: TimerHandle | undefined;
  ping: TimerHandle | undefined;
}

/** 这一句的文本有问题，换引擎也无济于事：单条文本过长、非法字符超过 10%。 */
const REQUEST_CODES = new Set([2204, 1042]);
const AUTH_CODE = 1004;
/** 排队的文本太多（2205）：稍后重发同一句。 */
const BACKPRESSURE = 2205;
const BACKPRESSURE_RETRY_MS = 300;
const HEX = /^[0-9a-fA-F]*$/;

function codeOf(message: Message): number {
  return message.base_resp?.status_code ?? 0;
}

export class MinimaxEngine implements Engine {
  readonly vendor = 'minimax' as const;
  readonly #options: MinimaxOptions;
  readonly #timeouts: EngineTimeouts;
  readonly #env: EngineEnv;
  readonly #serial = new Serial();
  #connection: Promise<Connection> | undefined;
  #closed = false;
  #current: Job | undefined;

  constructor(options: MinimaxOptions, timeouts: EngineTimeouts, env: EngineEnv) {
    this.#options = options;
    this.#timeouts = timeouts;
    this.#env = env;
  }

  async start(text: string, signal: AbortSignal): Promise<EngineStream> {
    const release = await this.#serial.acquire();
    if (signal.aborted || this.#closed) {
      release();
      return emptyStream(this.#options.sampleRate);
    }
    // 建连期间被中止：立即返回，连接在后台建完后照常留用。
    const connecting = this.#ensure();
    const winner = await Promise.race([
      connecting.then((connection) => ({ connection })),
      aborted(signal).then(() => undefined),
    ]).catch((error: unknown) => {
      release();
      throw error;
    });
    if (!winner) {
      connecting.then(release, release);
      return emptyStream(this.#options.sampleRate);
    }
    const job = new Job(signal);
    const rate = { value: this.#options.sampleRate };
    this.#current = job;
    this.#run(winner.connection, job, text, rate, () => {
      if (this.#current === job) this.#current = undefined;
      release();
    });
    await job.ready();
    if (job.stopped && !job.hasAudio) return emptyStream(rate.value);
    return { sampleRate: rate.value, chunks: job.chunks() };
  }

  close(): void {
    this.#closed = true;
    this.#current?.fail(new EngineError('引擎已关闭'));
    void this.#connection?.then(
      (connection) => connection.link.close(),
      () => {},
    );
    this.#connection = undefined;
  }

  #observe(kind: string, fields: Record<string, unknown> = {}): void {
    this.#env.observe?.({ at: this.#env.clock.now(), vendor: 'minimax', kind, ...fields });
  }

  #error(message: Message, secret: string): Error {
    const code = codeOf(message);
    const text = `MiniMax ${message.event ?? '响应'} 错误 ${code}：${redact(message.base_resp?.status_msg ?? '', [secret])}`;
    if (REQUEST_CODES.has(code)) return new RequestError(text);
    return new EngineError(text, { auth: code === AUTH_CODE });
  }

  /** 取得可用的连接；没有就建连并开始会话。 */
  #ensure(): Promise<Connection> {
    const existing = this.#connection;
    if (existing) {
      return existing.then(
        (connection) => (connection.link.isOpen ? connection : this.#reconnect()),
        () => this.#reconnect(),
      );
    }
    return this.#reconnect();
  }

  #reconnect(): Promise<Connection> {
    const connecting = this.#connect();
    this.#connection = connecting;
    connecting.catch(() => {
      if (this.#connection === connecting) this.#connection = undefined;
    });
    return connecting;
  }

  async #connect(): Promise<Connection> {
    const { clock } = this.#env;
    const secret = await this.#env.secret();
    if (!secret) throw new EngineError('缺少凭据 minimax');
    const startedAt = clock.now();
    this.#observe('connect');
    const link = await Link.open({
      url: this.#options.endpoint,
      headers: { Authorization: `Bearer ${secret}` },
      clock,
      timeoutMs: this.#timeouts.connectTimeoutMs,
      maxPayload: MAX_MESSAGE_BYTES,
    });
    this.#observe('open', { ms: clock.now() - startedAt });
    const connection: Connection = {
      link,
      secret,
      handler: undefined,
      onGone: undefined,
      idle: undefined,
      ping: undefined,
    };
    // 先接上等待者再接收消息：建连后服务端立即发出的 connected_success 不会被当成遗留消息。
    const hello = this.#expect(connection, 'connected_success');
    link.onClose((reason) => {
      this.#quiet(connection);
      this.#observe('closed', { reason });
      this.#env.log?.('tts.connection-closed', { engine: 'minimax', reason });
      connection.onGone?.(reason);
    });
    link.onMessage((data, binary) => this.#dispatch(connection, data, binary));
    try {
      await hello;
      this.#observe('hello', { ms: clock.now() - startedAt });
      link.send(JSON.stringify(this.#taskStart()));
      await this.#expect(connection, 'task_started');
    } catch (error) {
      link.close();
      throw error;
    }
    this.#observe('connected', { ms: clock.now() - startedAt });
    this.#env.log?.('tts.connected', { engine: 'minimax' });
    return connection;
  }

  #taskStart(): Record<string, unknown> {
    const o = this.#options;
    return {
      event: 'task_start',
      model: o.model,
      voice_setting: {
        voice_id: o.voiceId,
        speed: o.speed,
        vol: o.vol,
        pitch: o.pitch,
        ...(o.emotion ? { emotion: o.emotion } : {}),
      },
      audio_setting: { sample_rate: o.sampleRate, format: 'pcm', channel: 1 },
      subtitle_enable: true,
      subtitle_type: o.subtitleType,
      ...(o.languageBoost ? { language_boost: o.languageBoost } : {}),
    };
  }

  /** 等待某个事件；出错、断开或超时则拒绝。 */
  #expect(connection: Connection, event: string): Promise<Message> {
    const { clock } = this.#env;
    return new Promise((resolve, reject) => {
      const done = () => {
        clock.clearTimeout(timer);
        connection.handler = undefined;
        connection.onGone = undefined;
      };
      const timer = clock.setTimeout(() => {
        done();
        reject(new EngineError(`等待 ${event} 超时`));
      }, this.#timeouts.connectTimeoutMs);
      connection.handler = (message) => {
        if (codeOf(message) !== 0 || message.event === 'task_failed') {
          done();
          reject(this.#error(message, connection.secret));
        } else if (message.event === event) {
          done();
          resolve(message);
        }
      };
      connection.onGone = (reason) => {
        done();
        reject(new EngineError(`连接已断开：${reason}`));
      };
    });
  }

  #dispatch(connection: Connection, data: Buffer, binary: boolean): void {
    if (binary) {
      this.#observe('unexpected-binary', { bytes: data.length });
      return;
    }
    let message: Message;
    try {
      message = JSON.parse(data.toString('utf8')) as Message;
    } catch {
      this.#observe('invalid-json', { bytes: data.length });
      return;
    }
    if (connection.handler) {
      connection.handler(message);
      return;
    }
    // 空闲时收到的消息：上一句遗留的事件，或服务端的断开通知（例如 2201 空闲超时）。
    this.#observe('stale', { event: message.event, code: codeOf(message) });
    if (codeOf(message) !== 0 || message.event === 'task_failed') connection.link.close();
  }

  /** 停止空闲计时与 ping。 */
  #quiet(connection: Connection): void {
    const { clock } = this.#env;
    if (connection.idle) clock.clearTimeout(connection.idle);
    if (connection.ping) clock.clearTimeout(connection.ping);
    connection.idle = undefined;
    connection.ping = undefined;
  }

  /** 空闲：定时 ping（服务端回 pong 即重置它的空闲计时），空闲过久主动断开。 */
  #rest(connection: Connection): void {
    const { clock } = this.#env;
    this.#quiet(connection);
    const ping = () => {
      connection.ping = clock.setTimeout(ping, this.#options.pingIntervalMs);
      connection.link.ping();
    };
    connection.ping = clock.setTimeout(ping, this.#options.pingIntervalMs);
    connection.idle = clock.setTimeout(() => {
      this.#observe('idle-close');
      connection.link.close();
    }, this.#timeouts.idleCloseMs);
  }

  #run(
    connection: Connection,
    job: Job,
    text: string,
    rate: { value: number },
    release: () => void,
  ): void {
    const { clock } = this.#env;
    const { link } = connection;
    const decoder = new PcmDecoder();
    /** 每个句子（sentence_start）开始时已收到的采样数。 */
    const sentences: number[] = [];
    /** 各句各字幕片段的最新结果（按出现顺序）。 */
    const segments = new Map<string, WordStamp[]>();
    /** canceling：已发取消、等确认；draining：取消已确认，等被取消的 flush 的确认。 */
    let state: 'running' | 'canceling' | 'draining' | 'done' = 'running';
    let flushes = 0;
    let retrying = false;
    let samples = 0;
    let timer: TimerHandle | undefined;
    const startedAt = clock.now();
    this.#quiet(connection);

    const finish = (keep: boolean) => {
      if (state === 'done') return;
      state = 'done';
      if (timer) clock.clearTimeout(timer);
      connection.handler = undefined;
      connection.onGone = undefined;
      if (keep && link.isOpen && !this.#closed) this.#rest(connection);
      else link.close();
      release();
    };
    const fail = (error: Error) => {
      this.#observe('failed', { error: error.message });
      job.fail(error);
      finish(false);
    };
    const arm = (ms: number, what: string) => {
      if (timer) clock.clearTimeout(timer);
      timer = clock.setTimeout(() => {
        if (state === 'running') fail(new EngineError(`${what}超时（${ms}ms）`));
        else if (state === 'canceling' || state === 'draining') {
          this.#observe(state === 'canceling' ? 'cancel-timeout' : 'flush-timeout');
          finish(false);
        }
      }, ms);
    };
    const send = (message: Record<string, unknown>) => {
      try {
        link.send(JSON.stringify(message));
      } catch (error) {
        fail(error instanceof Error ? error : new EngineError(String(error)));
      }
    };
    const sendText = () => {
      send({ event: 'task_continue', text });
      send({ event: 'task_flush' });
      flushes += 1;
      this.#observe('text-sent', { chars: [...text].length });
    };
    const subtitle = (sub: Subtitle) => {
      const index = Math.max(0, sentences.length - 1);
      const baseMs = ((sentences[index] ?? 0) * 1000) / rate.value;
      const words: WordStamp[] = sub.timestamped_words?.length
        ? sub.timestamped_words.map((w) => ({
            text: w.word ?? '',
            startMs: baseMs + (w.time_begin ?? 0),
            endMs: baseMs + (w.time_end ?? 0),
          }))
        : sub.text
          ? [
              {
                text: sub.text,
                startMs: baseMs + (sub.time_begin ?? 0),
                endMs: baseMs + (sub.time_end ?? 0),
              },
            ]
          : [];
      segments.set(`${index}:${sub.text_begin ?? 0}`, words);
      const all = [...segments.values()].flat();
      job.push({ kind: 'words', words: all });
      this.#observe('words', { count: all.length, ms: clock.now() - startedAt });
    };

    job.onStop(() => {
      if (state !== 'running') return;
      state = 'canceling';
      send({ event: 'task_cancel' });
      this.#observe('cancel-sent', { samples });
      arm(this.#timeouts.cancelTimeoutMs, '取消');
    });
    connection.onGone = (reason) => {
      if (state === 'running') fail(new EngineError(`连接已断开：${reason}`));
      else finish(false);
    };
    connection.handler = (message) => {
      const code = codeOf(message);
      if (state === 'canceling' || state === 'draining') {
        if (message.data?.audio) {
          this.#observe('audio-after-cancel', { bytes: message.data.audio.length / 2 });
        }
        if (message.extra_info?.usage_characters !== undefined) {
          this.#observe('usage-after-cancel', {
            usageCharacters: message.extra_info.usage_characters,
          });
        }
        if (message.event === 'task_flushed') {
          flushes -= 1;
          this.#observe('flushed-after-cancel', { pendingFlushes: flushes });
          if (state === 'draining' && flushes <= 0) finish(true);
        } else if (message.event === 'task_canceled') {
          this.#observe('cancel-acked', { pendingFlushes: flushes });
          if (flushes <= 0) finish(true);
          else {
            state = 'draining';
            arm(this.#timeouts.cancelTimeoutMs, '取消');
          }
        } else if (code !== 0 || message.event === 'task_failed') {
          finish(false);
        }
        return;
      }
      if (state !== 'running') return;
      if (code === BACKPRESSURE) {
        this.#observe('backpressure');
        if (!retrying) {
          retrying = true;
          clock.setTimeout(() => {
            retrying = false;
            if (state === 'running') sendText();
          }, BACKPRESSURE_RETRY_MS);
        }
        return;
      }
      if (code !== 0 || message.event === 'task_failed') {
        fail(this.#error(message, connection.secret));
        return;
      }
      if (job.hasAudio) arm(this.#timeouts.stallTimeoutMs, '音频中断');
      switch (message.event) {
        case 'sentence_start':
          sentences.push(samples);
          return;
        case 'task_continued': {
          const info = message.extra_info;
          if (info?.audio_sample_rate && !job.hasAudio) rate.value = info.audio_sample_rate;
          if (info?.audio_size !== undefined || info?.usage_characters !== undefined) {
            this.#observe('info', {
              audioFormat: info.audio_format,
              audioChannel: info.audio_channel,
              audioSize: info.audio_size,
              audioLengthMs: info.audio_length,
              usageCharacters: info.usage_characters,
            });
          }
          const hex = message.data?.audio;
          if (hex) {
            if (!HEX.test(hex) || hex.length % 2 !== 0) {
              fail(new EngineError('MiniMax 音频不是十六进制'));
              return;
            }
            const pcm = decoder.push(Buffer.from(hex, 'hex'));
            if (pcm.length > 0) {
              const first = !job.hasAudio;
              samples += pcm.length;
              job.push({ kind: 'audio', pcm });
              this.#observe('audio', {
                samples: pcm.length,
                first,
                ms: clock.now() - startedAt,
              });
              arm(this.#timeouts.stallTimeoutMs, '音频中断');
            }
          }
          if (message.data?.subtitle) subtitle(message.data.subtitle);
          return;
        }
        case 'task_flushed':
          flushes -= 1;
          if (flushes <= 0 && !retrying) {
            this.#observe('done', { samples, ms: clock.now() - startedAt });
            job.end();
            finish(true);
          }
          return;
        default:
          this.#observe('event', { event: message.event });
      }
    };
    sendText();
    arm(this.#timeouts.firstAudioTimeoutMs, '首段音频');
  }
}
