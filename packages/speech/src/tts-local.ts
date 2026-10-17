import { existsSync } from 'node:fs';
import { endianness } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePlugin, SidecarHostService, startSidecar } from '@bellis/kernel';
import {
  TTS_STREAM_HEADER_BYTES,
  TtsInfoResult,
  TtsMethod,
  TtsSynthesizeResult,
} from '@bellis/protocol';
import { SafetyService } from '@bellis/safety';
import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { type Synthesis, TtsService } from './types.ts';

const isInfo = Compile(TtsInfoResult);
const isResult = Compile(TtsSynthesizeResult);
const MAX_STREAM = 0xffff_ffff;

/** 仓库根：sidecar 的源码与 uv 管理的虚拟环境都在这里。 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * uv 工作区虚拟环境里的解释器（先 `uv sync --locked`）。直接启动它，不经 `uv run`：
 * - Windows 上实测，强制终止 `uv run` 时真正的解释器不会随之退出（uv → venv 的 python.exe → 解释器），
 *   R-06 的第 3 步失效；venv 的 python.exe 被终止时，它启动的解释器随之退出（同样实测）；
 * - `uv run` 每次启动都会按锁文件同步环境，可能在直播中改动环境或访问网络。
 */
export function venvPython(root = ROOT, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? join(root, '.venv', 'Scripts', 'python.exe')
    : join(root, '.venv', 'bin', 'python');
}

/** sidecar 的包不打包安装，经 PYTHONPATH 指向源码目录。 */
function pythonPath(root = ROOT): string {
  return [
    join(root, 'python', 'bellis_sidecar', 'src'),
    join(root, 'sidecars', 'tts_local', 'src'),
  ].join(delimiter);
}

const FakeBackend = Type.Object(
  {
    sampleRate: Type.Integer({ minimum: 8000, maximum: 48000, default: 24_000 }),
    samplesPerChar: Type.Integer({ minimum: 1, maximum: 48_000, default: 4800 }),
    /** 每帧的采样数；帧长须在通道的单帧上限（1 MiB）以内。 */
    chunkSamples: Type.Integer({ minimum: 1, maximum: 48_000, default: 2400 }),
    firstChunkDelayMs: Type.Integer({ minimum: 0, default: 0 }),
    chunkDelayMs: Type.Integer({ minimum: 0, default: 0 }),
    /** 大于 0 时输出该频率的正弦测试音，否则输出静音。 */
    toneHz: Type.Number({ minimum: 0, default: 0 }),
    /** 朗读文本含这些片段时，sidecar 送出一半音频后崩溃（演练崩溃与恢复）。 */
    crashOn: Type.Array(Type.String({ minLength: 1, maxLength: 50 }), { default: [] }),
    /** 启动时派生的空转辅助进程数（演练“派生的进程随之退出”）。 */
    workers: Type.Integer({ minimum: 0, maximum: 4, default: 0 }),
  },
  { default: {} },
);

function fakeArgs(fake: Static<typeof FakeBackend>): string[] {
  return [
    '--backend',
    'fake',
    '--sample-rate',
    String(fake.sampleRate),
    '--samples-per-char',
    String(fake.samplesPerChar),
    '--chunk-samples',
    String(fake.chunkSamples),
    '--first-chunk-delay-ms',
    String(fake.firstChunkDelayMs),
    '--chunk-delay-ms',
    String(fake.chunkDelayMs),
    '--tone-hz',
    String(fake.toneHz),
    '--workers',
    String(fake.workers),
    ...fake.crashOn.flatMap((part) => ['--crash-on', part]),
  ];
}

/**
 * 一次合成的音频：sidecar 送来的帧按到达顺序排队，由一个消费者按序取出。
 * 消费方提前停止读取（`return()`）时立即取消合成，不等下一帧到达。
 */
class AudioStream implements AsyncIterableIterator<Int16Array> {
  /** 已收到的采样数，用来与 sidecar 报告的总数核对。 */
  samples = 0;
  readonly #queue: Int16Array[] = [];
  readonly #cancel: () => void;
  #waiter: PromiseWithResolvers<IteratorResult<Int16Array>> | undefined;
  #ended = false;
  #error: unknown;

  constructor(cancel: () => void) {
    this.#cancel = cancel;
  }

  push(frame: Int16Array): void {
    if (this.#ended) return;
    this.samples += frame.length;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    if (waiter) waiter.resolve({ value: frame, done: false });
    else this.#queue.push(frame);
  }

  end(): void {
    this.#ended = true;
    this.#flush();
  }

  fail(error: unknown): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#error = error ?? new Error('本地 TTS 合成失败');
    this.#flush();
  }

  next(): Promise<IteratorResult<Int16Array>> {
    const frame = this.#queue.shift();
    if (frame) return Promise.resolve({ value: frame, done: false });
    if (this.#error !== undefined) {
      const error = this.#error;
      this.#error = undefined;
      return Promise.reject(error);
    }
    if (this.#ended) return Promise.resolve({ value: undefined, done: true });
    this.#waiter = Promise.withResolvers();
    return this.#waiter.promise;
  }

  return(): Promise<IteratorResult<Int16Array>> {
    this.#cancel();
    this.#queue.length = 0;
    this.#error = undefined;
    this.#ended = true;
    this.#flush();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Int16Array> {
    return this;
  }

  #flush(): void {
    const waiter = this.#waiter;
    if (!waiter || this.#queue.length > 0) return;
    this.#waiter = undefined;
    if (this.#error !== undefined) {
      const error = this.#error;
      this.#error = undefined;
      waiter.reject(error);
    } else {
      waiter.resolve({ value: undefined, done: true });
    }
  }
}

/**
 * 本地降级 TTS 的代理插件（R-10）：拉起 Python sidecar（`sidecars/tts_local`），
 * 把它的 `tts.synthesize` 与二进制音频帧适配成 `tts@1`。
 *
 * - 音频帧：4 字节大端流编号 + 16 位小端 PCM；按流编号归到对应的合成，已取消或已结束的流的帧丢弃。
 *   帧格式不对视为 sidecar 故障。`tts.synthesize` 的应答在全部音频帧之后到达，即流结束，
 *   并核对采样总数。
 * - 取消：调用方的中止信号或消费方停止读取都会中止请求，经 `rpc.cancel` 停止 sidecar 中的生成。
 * - 本地 TTS 不出时间戳：`timing` 为 undefined，仲裁退化为整句粒度；Qwen3-ForcedAligner 的细化对齐
 *   待真实后端接入（R-11，PENDING）。
 * - sidecar 崩溃或连接断开：记入 `tts.degraded` 事件（降级目标现阶段只有“不可用”），
 *   内核撤回 `tts@1`，依赖方回到 WAITING，按退避重启后记 `tts.started`。
 */
export const localTts = definePlugin({
  manifest: {
    id: 'tts-local',
    version: '0.1.0',
    tier: 'ordinary',
    provides: [TtsService.ref],
    inject: [SidecarHostService.ref, SafetyService.ref],
    permissions: [],
    process: 'sidecar',
    config: Type.Object({
      /** 合成后端。现阶段只有 `fake`（测试与演练用）；Qwen3-TTS 待接入。 */
      backend: Type.Literal('fake'),
      fake: FakeBackend,
      /** 一句合成的截止时间。 */
      synthesizeTimeoutMs: Type.Integer({ minimum: 100, default: 30_000 }),
    }),
  },
  async activate(ctx) {
    if (endianness() !== 'LE') throw new Error('本地 TTS 的 PCM 为小端，宿主须运行在小端平台');
    const safety = ctx.service(SafetyService);
    const python = venvPython();
    if (!existsSync(python)) {
      throw new Error(`缺少 Python 虚拟环境 ${python}，先在仓库根运行 uv sync --locked`);
    }
    const config = ctx.config;
    let degraded = false;
    const degrade = (reason: string) => {
      if (degraded) return;
      degraded = true;
      safety.record('tts.degraded', {
        entry: ctx.entryId,
        engine: 'local',
        reason,
        fallback: 'unavailable',
      });
    };

    const streams = new Map<number, AudioStream>();
    const sidecar = await startSidecar(
      ctx,
      [TtsService.ref],
      {
        command: python,
        // -P：不把当前目录加进模块搜索路径；模块只从 PYTHONPATH 与虚拟环境加载。
        args: ['-P', '-m', 'tts_local', ...fakeArgs(config.fake)],
        env: { PYTHONPATH: pythonPath(), PYTHONUTF8: '1' },
        cwd: ROOT,
      },
      degrade,
    );
    const { rpc } = sidecar;
    // 撤销时先结束在途的流，再停止子进程（后注册先撤销）。
    ctx.register(() => {
      for (const audio of streams.values()) audio.fail(new Error('本地 TTS 已停用'));
      streams.clear();
    });

    rpc.connection.on('binary', (data: Buffer) => {
      const bytes = data.length - TTS_STREAM_HEADER_BYTES;
      if (bytes < 0 || bytes % 2 !== 0) {
        const reason = '本地 TTS sidecar 送来的音频帧格式不对';
        degrade(reason);
        ctx.fail(new Error(reason));
        return;
      }
      const audio = streams.get(data.readUInt32BE(0));
      if (!audio) return;
      const pcm = new Int16Array(bytes / 2);
      new Uint8Array(pcm.buffer).set(data.subarray(TTS_STREAM_HEADER_BYTES));
      audio.push(pcm);
    });

    const info = await rpc.request(TtsMethod.Info);
    if (!isInfo.Check(info)) throw new Error('本地 TTS sidecar 的 tts.info 应答不合法');
    ctx.log('tts-local.ready', { pid: sidecar.pid, ...info });
    safety.record('tts.started', {
      entry: ctx.entryId,
      engine: 'local',
      backend: info.backend,
      sampleRate: info.sampleRate,
    });

    let lastStream = 0;
    ctx.provide(TtsService, {
      async synthesize(spoken, signal): Promise<Synthesis> {
        if (ctx.signal.aborted) throw new Error('本地 TTS 已停用');
        lastStream = lastStream >= MAX_STREAM ? 1 : lastStream + 1;
        const stream = lastStream;
        const abort = new AbortController();
        const onAbort = () => abort.abort(signal.reason);
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
        const audio = new AudioStream(() => abort.abort(new Error('消费方已停止读取')));
        streams.set(stream, audio);
        rpc
          .request(
            TtsMethod.Synthesize,
            { stream, text: spoken },
            { signal: abort.signal, timeoutMs: config.synthesizeTimeoutMs },
          )
          .then(
            (result) => {
              if (!isResult.Check(result)) {
                audio.fail(new Error('本地 TTS sidecar 的 tts.synthesize 应答不合法'));
              } else if (result.samples !== audio.samples) {
                audio.fail(
                  new Error(`采样数不一致：sidecar 送出 ${result.samples}，收到 ${audio.samples}`),
                );
              } else {
                audio.end();
              }
            },
            (error: unknown) => {
              // 被取消时安静结束；其余（超时、连接断开、sidecar 报错）让消费方看到错误。
              if (abort.signal.aborted) audio.end();
              else audio.fail(error);
            },
          )
          .finally(() => {
            streams.delete(stream);
            signal.removeEventListener('abort', onAbort);
          });
        return {
          sampleRate: info.sampleRate,
          totalSamples: undefined,
          timing: undefined,
          frames: audio,
        };
      },
    });
  },
});
