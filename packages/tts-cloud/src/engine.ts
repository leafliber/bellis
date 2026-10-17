import type { Clock } from '@bellis/kernel';
import type { WordStamp } from '@bellis/speech';

export type Vendor = 'minimax' | 'volcengine';

/**
 * 引擎不可用：连接失败、鉴权失败、超时、限流或服务端出错。插件据此按 profile 切到下一个引擎，
 * 并在冷却时间内不再尝试这一家。
 */
export class EngineError extends Error {
  readonly auth: boolean;

  constructor(message: string, options: { auth?: boolean } = {}) {
    super(message);
    this.name = 'EngineError';
    this.auth = options.auth ?? false;
  }
}

/** 这一句本身被厂商拒绝（例如文本过长、非法字符过多）：换引擎也无济于事，这一句不播，引擎照常可用。 */
export class RequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestError';
  }
}

export type EngineChunk =
  | { kind: 'audio'; pcm: Int16Array }
  /** 这一句目前已知的全部时间戳（整体替换上一次）。 */
  | { kind: 'words'; words: readonly WordStamp[] };

export interface EngineStream {
  readonly sampleRate: number;
  /** 依次产出音频与时间戳；中止或提前停止迭代即向厂商取消，之后不再产出。厂商出错时抛错。 */
  readonly chunks: AsyncIterable<EngineChunk>;
}

export interface Engine {
  readonly vendor: Vendor;
  /**
   * 开始合成一句：收到第一段音频（或合成结束、或已中止）时返回。
   * 在此之前的失败以 {@link EngineError} 或 {@link RequestError} 拒绝。同一引擎一次只合成一句。
   */
  start(text: string, signal: AbortSignal): Promise<EngineStream>;
  /** 关闭连接，中止进行中的合成。 */
  close(): void;
}

/** 线路上的观测（探针用）。不含凭据，也不含朗读文本。 */
export interface WireEvent {
  /** 时钟上的时刻。 */
  at: number;
  vendor: Vendor;
  kind: string;
  [field: string]: unknown;
}

export type WireObserver = (event: WireEvent) => void;

export interface EngineTimeouts {
  /** 建连、握手与开始会话的截止时间。 */
  connectTimeoutMs: number;
  /** 发出文本到第一段音频的截止时间。 */
  firstAudioTimeoutMs: number;
  /** 合成过程中两条消息之间的最长间隔。 */
  stallTimeoutMs: number;
  /** 发出取消到厂商确认的截止时间；超时即断开连接。 */
  cancelTimeoutMs: number;
  /** 连接空闲这么久后主动关闭，下一句重新建连。 */
  idleCloseMs: number;
}

export interface EngineEnv {
  clock: Clock;
  /** 读取这家厂商的凭据（经宿主的凭据服务）；不存在时为 undefined。值不写日志、不进事件。 */
  secret(): Promise<string | undefined>;
  log?(event: string, fields: Record<string, unknown>): void;
  observe?: WireObserver;
}

/** 单条消息上限：最长一句的十六进制音频也远小于它。 */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** 把厂商返回的说明截短，并抹掉其中出现的凭据。 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join('***');
  return out.length > 200 ? `${out.slice(0, 200)}…` : out;
}

/**
 * 16 位小端 PCM 解码：厂商的音频分片不保证落在采样边界，奇数字节留到下一片。
 * 两家文档都没有写明 PCM 的位深与字节序，按 16 位有符号小端处理，由 S-07 核对（PENDING）。
 */
export class PcmDecoder {
  #carry: number | undefined;

  push(bytes: Uint8Array): Int16Array {
    let data = bytes;
    if (this.#carry !== undefined) {
      const joined = new Uint8Array(bytes.length + 1);
      joined[0] = this.#carry;
      joined.set(bytes, 1);
      data = joined;
      this.#carry = undefined;
    }
    const count = Math.floor(data.length / 2);
    if (data.length % 2 === 1) this.#carry = data[data.length - 1];
    const view = new DataView(data.buffer, data.byteOffset, count * 2);
    const pcm = new Int16Array(count);
    for (let i = 0; i < count; i += 1) pcm[i] = view.getInt16(i * 2, true);
    return pcm;
  }
}

/** 同一引擎一次只合成一句：上一句（含取消后的收尾）结束后才开始下一句。 */
export class Serial {
  #tail: Promise<void> = Promise.resolve();

  /** 排队取得执行权；返回的释放函数可重复调用。 */
  acquire(): Promise<() => void> {
    const gate = Promise.withResolvers<void>();
    const previous = this.#tail;
    this.#tail = previous.then(() => gate.promise);
    let released = false;
    return previous.then(() => () => {
      if (released) return;
      released = true;
      gate.resolve();
    });
  }
}

export function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

export function emptyStream(sampleRate: number): EngineStream {
  return { sampleRate, chunks: (async function* () {})() };
}

/**
 * 一句合成在宿主这一侧的状态：厂商连接把音频与时间戳推进来，使用方按顺序取走。
 * 使用方中止或提前停止迭代即“停止”：之后推进来的数据一律丢弃，并通知适配器向厂商取消。
 */
export class Job {
  readonly #items: EngineChunk[] = [];
  readonly #ready = Promise.withResolvers<void>();
  readonly #signal: AbortSignal;
  readonly #onAbort = () => this.stop();
  #wake: (() => void) | undefined;
  #ended = false;
  #error: Error | undefined;
  #stopped = false;
  #audio = false;
  #onStop: (() => void) | undefined;

  constructor(signal: AbortSignal) {
    this.#signal = signal;
    signal.addEventListener('abort', this.#onAbort, { once: true });
  }

  /** 使用方已经不要后续数据。 */
  get stopped(): boolean {
    return this.#stopped;
  }

  /** 合成已结束（完成或出错）。 */
  get finished(): boolean {
    return this.#ended || this.#error !== undefined;
  }

  get hasAudio(): boolean {
    return this.#audio;
  }

  /** 停止时（且合成尚未结束）调用一次，适配器在这里向厂商取消。 */
  onStop(handler: () => void): void {
    this.#onStop = handler;
  }

  /** 推进一段数据；已停止或已结束时丢弃并返回 false。 */
  push(chunk: EngineChunk): boolean {
    if (this.#stopped || this.finished) return false;
    this.#items.push(chunk);
    if (chunk.kind === 'audio') {
      this.#audio = true;
      this.#ready.resolve();
    }
    this.#wake?.();
    return true;
  }

  end(): void {
    if (this.finished) return;
    this.#ended = true;
    this.#detach();
  }

  fail(error: Error): void {
    if (this.finished) return;
    this.#error = error;
    this.#detach();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    const running = !this.finished;
    this.#detach();
    if (running) this.#onStop?.();
  }

  /** 第一段音频到达、合成结束或已停止时返回；第一段音频之前出错则抛出该错误。 */
  async ready(): Promise<void> {
    await this.#ready.promise;
    if (!this.#audio && this.#error) throw this.#error;
  }

  async *chunks(): AsyncGenerator<EngineChunk> {
    try {
      for (;;) {
        if (this.#stopped) return;
        const item = this.#items.shift();
        if (item) {
          yield item;
          continue;
        }
        if (this.#error) throw this.#error;
        if (this.#ended) return;
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
        this.#wake = undefined;
      }
    } finally {
      // 提前停止迭代（例如 Stage 截断了这一句）等同于取消。
      this.stop();
    }
  }

  #detach(): void {
    this.#signal.removeEventListener('abort', this.#onAbort);
    this.#ready.resolve();
    this.#wake?.();
  }
}
