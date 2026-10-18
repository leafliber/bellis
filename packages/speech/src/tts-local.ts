import { existsSync } from 'node:fs';
import { endianness } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePlugin, SidecarHostService, startSidecar } from '@bellis/kernel';
import {
  SidecarHealth,
  SidecarHealthResult,
  type SidecarQos,
  TTS_STREAM_HEADER_BYTES,
  TtsInfoResult,
  TtsMethod,
  TtsStatus,
  TtsSynthesizeResult,
  TtsWordsParams,
} from '@bellis/protocol';
import { SafetyService } from '@bellis/safety';
import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { Alignment } from './timing.ts';
import { LocalTtsService, type Synthesis, type TtsEngine } from './types.ts';

const isInfo = Compile(TtsInfoResult);
const isStatus = Compile(TtsStatus);
const isResult = Compile(TtsSynthesizeResult);
const isWords = Compile(TtsWordsParams);
const isHealth = Compile(SidecarHealthResult);
const MAX_STREAM = 0xffff_ffff;

/** 仓库根：sidecar 的源码与 uv 管理的虚拟环境都在这里。 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * uv 工作区虚拟环境里的解释器（先 `uv sync --locked`；真实后端还要 `--group tts-local`）。
 * 直接启动它，不经 `uv run`：
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
    /** 模拟模型加载的耗时与失败。 */
    loadDelayMs: Type.Integer({ minimum: 0, default: 0 }),
    /** 连接宿主之前先等这么久，模拟启动慢的 sidecar（插件激活随之变慢）。 */
    startupDelayMs: Type.Integer({ minimum: 0, maximum: 5000, default: 0 }),
    loadError: Type.String({ maxLength: 100, default: '' }),
    /** 给出精确的逐码点时间戳，模拟强制对齐。 */
    aligned: Type.Boolean({ default: false }),
  },
  { default: {} },
);

/** 模型权重从 Hugging Face 的官方仓库按提交固定版本下载到仓库外的缓存；运行时只读本地缓存。 */
const QwenBackend = Type.Object(
  {
    model: Type.String({ minLength: 1, default: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice' }),
    modelRevision: Type.String({
      pattern: '^[0-9a-f]{40}$',
      default: '85e237c12c027371202489a0ec509ded67b5e4b5',
    }),
    /** 空串表示不做强制对齐，只用插值。 */
    aligner: Type.String({ default: 'Qwen/Qwen3-ForcedAligner-0.6B' }),
    alignerRevision: Type.String({
      pattern: '^([0-9a-f]{40})?$',
      default: 'c7cbfc2048c462b0d63a45797104fc9db3ad62b7',
    }),
    /** CustomVoice 模型的预置音色，例如 `vivian`；须在 profile 中显式选择。 */
    speaker: Type.String({ pattern: '^[a-z_]*$', maxLength: 32, default: '' }),
    language: Type.String({ pattern: '^[a-z]+$', default: 'chinese' }),
    device: Type.String({ pattern: '^(cuda(:[0-9]+)?|cpu)$', default: 'cuda:0' }),
    dtype: Type.Union(
      [Type.Literal('bfloat16'), Type.Literal('float16'), Type.Literal('float32')],
      {
        default: 'bfloat16',
      },
    ),
    chunkMs: Type.Integer({ minimum: 10, maximum: 1000, default: 100 }),
  },
  { default: {} },
);

export const LocalTtsConfig = Type.Object({
  /** 合成后端：`qwen3` 为 Qwen3-TTS（只在装了 tts-local 依赖组的 Windows 真机上可用）；`fake` 用于测试与演练。 */
  backend: Type.Union([Type.Literal('fake'), Type.Literal('qwen3')]),
  fake: FakeBackend,
  qwen3: QwenBackend,
  /** 两段式对齐的插值按这个语速估计：一个普通码点的毫秒数。 */
  msPerChar: Type.Number({ exclusiveMinimum: 0, default: 220 }),
  /** 一句合成的截止时间（含强制对齐）。 */
  synthesizeTimeoutMs: Type.Integer({ minimum: 100, default: 60_000 }),
});
export type LocalTtsConfig = Static<typeof LocalTtsConfig>;

/** 由配置得到 sidecar 的命令行参数；qwen3 没选音色时返回原因。 */
export function sidecarArgs(config: LocalTtsConfig): string[] | { error: string } {
  if (config.backend === 'qwen3') {
    const q = config.qwen3;
    if (!q.speaker) return { error: 'qwen3 后端未配置音色（speaker）' };
    if (q.aligner && !q.alignerRevision) return { error: 'qwen3 后端的对齐模型未固定版本' };
    return [
      '--backend',
      'qwen3',
      '--model',
      q.model,
      '--model-revision',
      q.modelRevision,
      '--aligner',
      q.aligner,
      '--aligner-revision',
      q.alignerRevision,
      '--speaker',
      q.speaker,
      '--language',
      q.language,
      '--device',
      q.device,
      '--dtype',
      q.dtype,
      '--chunk-ms',
      String(q.chunkMs),
    ];
  }
  const f = config.fake;
  return [
    '--backend',
    'fake',
    '--sample-rate',
    String(f.sampleRate),
    '--samples-per-char',
    String(f.samplesPerChar),
    '--chunk-samples',
    String(f.chunkSamples),
    '--first-chunk-delay-ms',
    String(f.firstChunkDelayMs),
    '--chunk-delay-ms',
    String(f.chunkDelayMs),
    '--tone-hz',
    String(f.toneHz),
    '--workers',
    String(f.workers),
    '--load-delay-ms',
    String(f.loadDelayMs),
    '--startup-delay-ms',
    String(f.startupDelayMs),
    ...(f.loadError ? ['--load-error', f.loadError] : []),
    ...(f.aligned ? ['--aligned'] : []),
    ...f.crashOn.flatMap((part) => ['--crash-on', part]),
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

function describe(status: TtsStatus): string {
  if (status.state === 'loading') return '模型加载中';
  if (status.state === 'failed') return status.detail ?? '模型加载失败';
  return status.detail ? `就绪（${status.detail}）` : '就绪';
}

/** 状态说明只在节流状态不是预期值时附上它：HighQoS 与非 Windows 不附。 */
const QOS_NOTES: Partial<Record<SidecarQos, string>> = {
  eco: 'sidecar 被系统节流（EcoQoS）',
  default: 'sidecar 没有声明 HighQoS（节流由系统管理）',
  unknown: '读不到 sidecar 的节流状态',
};

/**
 * 本地降级 TTS 的代理插件（R-10）：拉起 Python sidecar（`sidecars/tts_local`），
 * 把它的 `tts.synthesize`、二进制音频帧与字级时间戳适配成本地引擎 `tts.local@1`，由 `tts-router` 选用。
 *
 * - 握手立即完成，插件随即激活；模型在 sidecar 里后台加载，加载完成前引擎报告未就绪（“模型加载中”），
 *   加载失败报告原因。状态变化由 sidecar 的 `tts.status` 通知送来。
 * - 音频帧：4 字节大端流编号 + 16 位小端 PCM；按流编号归到对应的合成，已取消或已结束的流的帧丢弃。
 *   帧格式不对视为 sidecar 故障。`tts.synthesize` 的应答在全部音频帧与时间戳之后到达，即流结束，
 *   并核对采样总数。
 * - 两段式对齐（R-11）：句段一到即按字数插值；Qwen3-ForcedAligner 的字级时间戳（`tts.words`）到达后细化；
 *   流结束后按实际采样数修正。`Synthesis` 的映射是活的。
 * - 取消：调用方的中止信号或消费方停止读取都会中止请求，经 `rpc.cancel` 停止 sidecar 中的送出。
 * - sidecar 崩溃或连接断开：记入 `tts.degraded`，内核撤回 `tts.local@1`（路由跳过它，`tts@1` 不消失），
 *   按退避重启；模型就绪时记 `tts.started`。
 * - 节流状态：sidecar 在 Windows 上启动时声明 HighQoS。激活时与每次 `qos()`（开播预检）经 `sidecar.health`
 *   读回；不是 HighQoS（非 Windows 除外）时状态说明附上它。
 */
export const localTts = definePlugin({
  manifest: {
    id: 'tts-local',
    version: '0.2.0',
    tier: 'ordinary',
    provides: [LocalTtsService.ref],
    inject: [SidecarHostService.ref, SafetyService.ref],
    permissions: [],
    process: 'sidecar',
    config: LocalTtsConfig,
  },
  async activate(ctx) {
    if (endianness() !== 'LE') throw new Error('本地 TTS 的 PCM 为小端，宿主须运行在小端平台');
    const safety = ctx.service(SafetyService);
    const config = ctx.config;
    const args = sidecarArgs(config);
    if ('error' in args) throw new Error(args.error);
    const python = venvPython();
    if (!existsSync(python)) {
      throw new Error(`缺少 Python 虚拟环境 ${python}，先在仓库根运行 uv sync --locked`);
    }

    let degraded = false;
    const degrade = (reason: string) => {
      if (degraded) return;
      degraded = true;
      safety.record('tts.degraded', {
        entry: ctx.entryId,
        engine: 'local',
        reason,
        fallback: 'router',
      });
    };

    const streams = new Map<number, { audio: AudioStream; alignment: Alignment }>();
    const hfHome = process.env.HF_HOME;
    const sidecar = await startSidecar(
      ctx,
      [LocalTtsService.ref],
      {
        command: python,
        // -P：不把当前目录加进模块搜索路径；模块只从 PYTHONPATH 与虚拟环境加载。
        args: ['-P', '-m', 'tts_local', ...args],
        env: {
          PYTHONPATH: pythonPath(),
          PYTHONUTF8: '1',
          // 模型只从本地缓存读取，运行时不联网下载。
          HF_HUB_OFFLINE: '1',
          HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
          ...(hfHome ? { HF_HOME: hfHome } : {}),
        },
        cwd: ROOT,
      },
      degrade,
    );
    const { rpc } = sidecar;
    // 撤销时先结束在途的流，再停止子进程（后注册先撤销）。
    ctx.register(() => {
      for (const { audio } of streams.values()) audio.fail(new Error('本地 TTS 已停用'));
      streams.clear();
    });

    let status: TtsStatus = { state: 'loading' };
    const update = (next: TtsStatus) => {
      const was = status.state;
      status = next;
      if (was === next.state) return;
      ctx.log('tts-local.status', { ...next });
      if (next.state === 'ready') {
        safety.record('tts.started', {
          entry: ctx.entryId,
          engine: 'local',
          backend: config.backend,
          sampleRate: next.sampleRate ?? null,
        });
      } else if (next.state === 'failed') {
        degrade(describe(next));
      }
    };
    // 先挂上通知再查询状态：查询之后的变化都会收到，之前的已反映在查询结果里。
    rpc.onNotification(TtsMethod.Status, (params) => {
      if (isStatus.Check(params)) update(params);
    });
    rpc.onNotification(TtsMethod.Words, (params) => {
      if (!isWords.Check(params)) return;
      streams.get(params.stream)?.alignment.refine(params.words);
    });
    rpc.connection.on('binary', (data: Buffer) => {
      const bytes = data.length - TTS_STREAM_HEADER_BYTES;
      if (bytes < 0 || bytes % 2 !== 0) {
        const reason = '本地 TTS sidecar 送来的音频帧格式不对';
        degrade(reason);
        ctx.fail(new Error(reason));
        return;
      }
      const entry = streams.get(data.readUInt32BE(0));
      if (!entry) return;
      const pcm = new Int16Array(bytes / 2);
      new Uint8Array(pcm.buffer).set(data.subarray(TTS_STREAM_HEADER_BYTES));
      entry.audio.push(pcm);
    });

    /** 最近一次读回的节流状态；应答里没有 `qos` 或请求失败时为 `unknown`。 */
    let qos: SidecarQos = 'unknown';
    const readQos = async (): Promise<SidecarQos> => {
      let next: SidecarQos = 'unknown';
      try {
        const health = await rpc.request(SidecarHealth);
        if (isHealth.Check(health) && health.qos !== undefined) next = health.qos;
      } finally {
        qos = next;
      }
      return next;
    };

    const info = await rpc.request(TtsMethod.Info);
    if (!isInfo.Check(info)) throw new Error('本地 TTS sidecar 的 tts.info 应答不合法');
    // 读不到节流状态不影响激活：状态说明与开播预检会报告。
    await readQos().catch(() => undefined);
    ctx.log('tts-local.ready', {
      pid: sidecar.pid,
      backend: info.backend,
      processes: info.processes,
      qos,
    });
    update(info.status);

    let lastStream = 0;
    const engine: TtsEngine = {
      get ready() {
        return status.state === 'ready' && !ctx.signal.aborted;
      },
      get status() {
        const note = QOS_NOTES[qos];
        return note ? `${describe(status)}；${note}` : describe(status);
      },
      qos: readQos,
      async synthesize(spoken, signal): Promise<Synthesis> {
        if (ctx.signal.aborted) throw new Error('本地 TTS 已停用');
        const sampleRate = status.sampleRate;
        if (status.state !== 'ready' || sampleRate === undefined) throw new Error(describe(status));
        lastStream = lastStream >= MAX_STREAM ? 1 : lastStream + 1;
        const stream = lastStream;
        const abort = new AbortController();
        const onAbort = () => abort.abort(signal.reason);
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
        const audio = new AudioStream(() => abort.abort(new Error('消费方已停止读取')));
        const alignment = new Alignment(spoken, sampleRate, { msPerChar: config.msPerChar });
        streams.set(stream, { audio, alignment });
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
                alignment.complete(result.samples);
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
          sampleRate,
          get totalSamples() {
            return alignment.totalSamples;
          },
          get timing() {
            return alignment.timing;
          },
          frames: audio,
        };
      },
    };
    ctx.provide(LocalTtsService, engine);
  },
});
