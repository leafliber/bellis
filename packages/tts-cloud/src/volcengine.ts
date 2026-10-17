import { randomUUID } from 'node:crypto';
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
  redact,
  Serial,
} from './engine.ts';
import { Link } from './link.ts';
import {
  decodeFrame,
  Event,
  encodeRequest,
  jsonPayload,
  MessageType,
  type ServerFrame,
} from './volcengine-frame.ts';

/**
 * 火山引擎（豆包语音）V3 双向流式语音合成（`/api/v3/tts/bidirection`）的适配器。协议以官方文档为准：
 * https://docs.volcengine.com/docs/6561/1329505 （WebSocket 双向流式-V3）。
 *
 * - 鉴权头：新版控制台只需 `X-Api-Key`；旧版控制台用 `X-Api-App-Id` 与 `X-Api-Access-Key`。
 *   另带 `X-Api-Resource-Id`（模型版本与计费方式）、`X-Api-Connect-Id`（排查用）与
 *   `X-Control-Require-Usage-Tokens-Return: *`（会话结束时回报计费字数，探针据此核对取消后是否仍计费）。
 * - 一条连接可以先后开多个会话（不能同时）：StartConnection → ConnectionStarted 之后，每句
 *   StartSession → SessionStarted → TaskRequest（文本）→ FinishSession，音频随 TTSResponse 到达，
 *   SessionFinished 表示这一句结束。会话 ID 由客户端生成，其它会话的帧一律丢弃。
 * - 取消发 CancelSession，收到 SessionCanceled（或 SessionFinished）即结束；之后同一连接可以开新会话。
 * - 时间戳：TTS 1.0 类资源用 `enable_timestamp`，随 TTSSentenceEnd 返回；TTS 2.0 类资源用 `enable_subtitle`，
 *   由 TTSSubtitle 事件返回。文档的事件号表里没有 TTSSubtitle 的编号，因此凡是带 `words` 的 JSON 响应都按时间戳处理。
 *   时间以秒计，相对整个会话（每句一个会话，即相对这一句音频开头）。
 */
export interface VolcengineOptions {
  endpoint: string;
  resourceId: string;
  speaker: string;
  /** 只在声音复刻 2.0 时需要；空串表示不传。 */
  model: string;
  sampleRate: number;
  speechRate: number;
  loudnessRate: number;
  /** `subtitle`：enable_subtitle（TTS 2.0、ICL 2.0）；`timestamp`：enable_timestamp（TTS 1.0、ICL 1.0）。 */
  timestamps: 'subtitle' | 'timestamp';
}

/** 凭据：新版控制台的 API Key 原样存放；旧版控制台存 JSON `{"appId": "…", "accessToken": "…"}`。 */
export function volcengineHeaders(secret: string): Record<string, string> {
  const trimmed = secret.trim();
  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new EngineError('凭据 volcengine 不是合法的 JSON');
    }
    const { appId, accessToken } = (parsed ?? {}) as { appId?: unknown; accessToken?: unknown };
    if (typeof appId !== 'string' || typeof accessToken !== 'string' || !appId || !accessToken) {
      throw new EngineError('凭据 volcengine 的 JSON 须含 appId 与 accessToken');
    }
    return { 'X-Api-App-Id': appId, 'X-Api-Access-Key': accessToken };
  }
  return { 'X-Api-Key': trimmed };
}

interface Connection {
  link: Link;
  secrets: string[];
  handler: ((frame: ServerFrame) => void) | undefined;
  onGone: ((reason: string) => void) | undefined;
  idle: TimerHandle | undefined;
}

const SUCCESS = 20_000_000;

interface Word {
  word?: unknown;
  startTime?: unknown;
  endTime?: unknown;
}

export class VolcengineEngine implements Engine {
  readonly vendor = 'volcengine' as const;
  readonly #options: VolcengineOptions;
  readonly #timeouts: EngineTimeouts;
  readonly #env: EngineEnv;
  readonly #serial = new Serial();
  #connection: Promise<Connection> | undefined;
  #closed = false;
  #current: Job | undefined;

  constructor(options: VolcengineOptions, timeouts: EngineTimeouts, env: EngineEnv) {
    this.#options = options;
    this.#timeouts = timeouts;
    this.#env = env;
  }

  async start(text: string, signal: AbortSignal): Promise<EngineStream> {
    const rate = this.#options.sampleRate;
    const release = await this.#serial.acquire();
    if (signal.aborted || this.#closed) {
      release();
      return emptyStream(rate);
    }
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
      return emptyStream(rate);
    }
    const job = new Job(signal);
    this.#current = job;
    this.#run(winner.connection, job, text, () => {
      if (this.#current === job) this.#current = undefined;
      release();
    });
    await job.ready();
    if (job.stopped && !job.hasAudio) return emptyStream(rate);
    return { sampleRate: rate, chunks: job.chunks() };
  }

  close(): void {
    this.#closed = true;
    this.#current?.fail(new EngineError('引擎已关闭'));
    void this.#connection?.then(
      (connection) => {
        if (connection.link.isOpen) {
          try {
            connection.link.send(encodeRequest(Event.FinishConnection, {}));
          } catch {}
        }
        connection.link.close();
      },
      () => {},
    );
    this.#connection = undefined;
  }

  #observe(kind: string, fields: Record<string, unknown> = {}): void {
    this.#env.observe?.({ at: this.#env.clock.now(), vendor: 'volcengine', kind, ...fields });
  }

  /** 失败帧（ConnectionFailed、SessionFailed、错误帧）的说明。 */
  #failure(frame: ServerFrame, connection: Connection): EngineError {
    const meta = jsonPayload(frame);
    const code = frame.errorCode ?? (meta?.status_code as number | undefined);
    const text =
      typeof meta?.message === 'string'
        ? meta.message
        : typeof meta?.error === 'string'
          ? meta.error
          : frame.payload.toString('utf8');
    const what =
      frame.type === MessageType.Error
        ? '错误帧'
        : frame.event === Event.ConnectionFailed
          ? '建连失败'
          : '会话失败';
    const auth = /unauthori[sz]ed|auth|forbidden/i.test(text);
    return new EngineError(
      `火山引擎${what}${code === undefined ? '' : ` ${code}`}：${redact(text, connection.secrets)}`,
      { auth },
    );
  }

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
    if (!secret) throw new EngineError('缺少凭据 volcengine');
    const auth = volcengineHeaders(secret);
    const startedAt = clock.now();
    this.#observe('connect');
    const link = await Link.open({
      url: this.#options.endpoint,
      headers: {
        ...auth,
        'X-Api-Resource-Id': this.#options.resourceId,
        'X-Api-Connect-Id': randomUUID(),
        'X-Control-Require-Usage-Tokens-Return': '*',
      },
      clock,
      timeoutMs: this.#timeouts.connectTimeoutMs,
      maxPayload: MAX_MESSAGE_BYTES,
    });
    const connection: Connection = {
      link,
      secrets: Object.values(auth),
      handler: undefined,
      onGone: undefined,
      idle: undefined,
    };
    const started = this.#expect(connection, (frame) => frame.event === Event.ConnectionStarted);
    link.onClose((reason) => {
      this.#quiet(connection);
      this.#observe('closed', { reason });
      this.#env.log?.('tts.connection-closed', { engine: 'volcengine', reason });
      connection.onGone?.(reason);
    });
    link.onMessage((data, binary) => this.#dispatch(connection, data, binary));
    try {
      link.send(encodeRequest(Event.StartConnection, {}));
      await started;
    } catch (error) {
      link.close();
      throw error;
    }
    const logId = link.responseHeaders['x-tt-logid'];
    this.#observe('connected', { ms: clock.now() - startedAt, logId });
    this.#env.log?.('tts.connected', { engine: 'volcengine', logId });
    return connection;
  }

  /** 等待满足条件的帧；失败帧、断开或超时则拒绝。 */
  #expect(connection: Connection, match: (frame: ServerFrame) => boolean): Promise<ServerFrame> {
    const { clock } = this.#env;
    return new Promise((resolve, reject) => {
      const done = () => {
        clock.clearTimeout(timer);
        connection.handler = undefined;
        connection.onGone = undefined;
      };
      const timer = clock.setTimeout(() => {
        done();
        reject(new EngineError('等待火山引擎响应超时'));
      }, this.#timeouts.connectTimeoutMs);
      connection.handler = (frame) => {
        if (
          frame.type === MessageType.Error ||
          frame.event === Event.ConnectionFailed ||
          frame.event === Event.SessionFailed
        ) {
          done();
          reject(this.#failure(frame, connection));
        } else if (match(frame)) {
          done();
          resolve(frame);
        }
      };
      connection.onGone = (reason) => {
        done();
        reject(new EngineError(`连接已断开：${reason}`));
      };
    });
  }

  #dispatch(connection: Connection, data: Buffer, binary: boolean): void {
    if (!binary) {
      // 文本帧用来反馈异常（文档“WebSocket 传输响应”）。
      const text = redact(data.toString('utf8'), connection.secrets);
      this.#observe('text-frame', { text });
      this.#env.log?.('tts.vendor-error', { engine: 'volcengine', text });
      connection.link.close();
      return;
    }
    let frame: ServerFrame;
    try {
      frame = decodeFrame(data);
    } catch (error) {
      this.#observe('invalid-frame', { error: (error as Error).message, bytes: data.length });
      return;
    }
    if (connection.handler) {
      connection.handler(frame);
      return;
    }
    this.#observe('stale', { event: frame.event, type: frame.type });
    if (frame.type === MessageType.Error || frame.event === Event.ConnectionFailed) {
      connection.link.close();
    }
  }

  #quiet(connection: Connection): void {
    if (connection.idle) this.#env.clock.clearTimeout(connection.idle);
    connection.idle = undefined;
  }

  #rest(connection: Connection): void {
    this.#quiet(connection);
    connection.idle = this.#env.clock.setTimeout(() => {
      this.#observe('idle-close');
      try {
        connection.link.send(encodeRequest(Event.FinishConnection, {}));
      } catch {}
      connection.link.close();
    }, this.#timeouts.idleCloseMs);
  }

  #sessionParams(): Record<string, unknown> {
    const o = this.#options;
    return {
      speaker: o.speaker,
      ...(o.model ? { model: o.model } : {}),
      audio_params: {
        format: 'pcm',
        sample_rate: o.sampleRate,
        speech_rate: o.speechRate,
        loudness_rate: o.loudnessRate,
        ...(o.timestamps === 'subtitle' ? { enable_subtitle: true } : { enable_timestamp: true }),
      },
    };
  }

  #run(connection: Connection, job: Job, text: string, release: () => void): void {
    const { clock } = this.#env;
    const { link } = connection;
    const sessionId = randomUUID();
    const decoder = new PcmDecoder();
    const words = new Map<string, WordStamp>();
    let state: 'starting' | 'running' | 'canceling' | 'done' = 'starting';
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
        if (state === 'starting' || state === 'running')
          fail(new EngineError(`${what}超时（${ms}ms）`));
        else if (state === 'canceling') {
          this.#observe('cancel-timeout');
          finish(false);
        }
      }, ms);
    };
    const send = (event: number, payload: unknown) => {
      try {
        link.send(encodeRequest(event, payload, sessionId));
      } catch (error) {
        fail(error instanceof Error ? error : new EngineError(String(error)));
      }
    };
    const addWords = (list: unknown) => {
      if (!Array.isArray(list)) return;
      for (const item of list as Word[]) {
        if (typeof item?.word !== 'string' || typeof item.startTime !== 'number') continue;
        const endTime = typeof item.endTime === 'number' ? item.endTime : item.startTime;
        words.set(`${item.startTime}:${item.word}`, {
          text: item.word,
          startMs: item.startTime * 1000,
          endMs: endTime * 1000,
        });
      }
      const all = [...words.values()].sort((a, b) => a.startMs - b.startMs);
      job.push({ kind: 'words', words: all });
      this.#observe('words', { count: all.length, ms: clock.now() - startedAt });
    };

    job.onStop(() => {
      if (state !== 'starting' && state !== 'running') return;
      state = 'canceling';
      send(Event.CancelSession, {});
      this.#observe('cancel-sent', { samples });
      arm(this.#timeouts.cancelTimeoutMs, '取消');
    });
    connection.onGone = (reason) => {
      if (state === 'starting' || state === 'running') {
        fail(new EngineError(`连接已断开：${reason}`));
      } else finish(false);
    };
    connection.handler = (frame) => {
      if (frame.type === MessageType.Error || frame.event === Event.ConnectionFailed) {
        if (state === 'canceling') finish(false);
        else fail(this.#failure(frame, connection));
        return;
      }
      if (frame.id !== sessionId) {
        this.#observe('stale', { event: frame.event });
        return;
      }
      const meta = frame.type === MessageType.FullServerResponse ? jsonPayload(frame) : undefined;
      if (state === 'canceling') {
        if (frame.type === MessageType.AudioOnlyServer) {
          this.#observe('audio-after-cancel', { bytes: frame.payload.length });
        }
        if (
          frame.event === Event.SessionCanceled ||
          frame.event === Event.SessionFinished ||
          frame.event === Event.SessionFailed
        ) {
          this.#observe('cancel-acked', { event: frame.event, usage: meta?.usage });
          finish(frame.event !== Event.SessionFailed);
        }
        return;
      }
      if (job.hasAudio) arm(this.#timeouts.stallTimeoutMs, '音频中断');
      switch (frame.event) {
        case Event.SessionStarted:
          if (state !== 'starting') return;
          state = 'running';
          send(Event.TaskRequest, {
            event: Event.TaskRequest,
            namespace: 'BidirectionalTTS',
            req_params: { ...this.#sessionParams(), text },
          });
          send(Event.FinishSession, {});
          this.#observe('text-sent', { chars: [...text].length });
          arm(this.#timeouts.firstAudioTimeoutMs, '首段音频');
          return;
        case Event.TTSResponse: {
          const pcm = decoder.push(frame.payload);
          if (pcm.length === 0) return;
          const first = !job.hasAudio;
          samples += pcm.length;
          job.push({ kind: 'audio', pcm });
          this.#observe('audio', { samples: pcm.length, first, ms: clock.now() - startedAt });
          arm(this.#timeouts.stallTimeoutMs, '音频中断');
          return;
        }
        case Event.SessionFinished: {
          const code = meta?.status_code;
          if (typeof code === 'number' && code !== SUCCESS) {
            fail(this.#failure(frame, connection));
            return;
          }
          this.#observe('done', { samples, ms: clock.now() - startedAt, usage: meta?.usage });
          job.end();
          finish(true);
          return;
        }
        case Event.SessionFailed:
          fail(this.#failure(frame, connection));
          return;
        default:
          // TTSSentenceEnd（TTS 1.0 的时间戳）、TTSSubtitle（TTS 2.0 的字幕，事件号文档未列）等。
          if (meta && 'words' in meta) addWords(meta.words);
          else this.#observe('event', { event: frame.event });
      }
    };
    send(Event.StartSession, {
      event: Event.StartSession,
      namespace: 'BidirectionalTTS',
      req_params: this.#sessionParams(),
    });
    arm(this.#timeouts.connectTimeoutMs, '开始会话');
  }
}
