import { ClockService, definePlugin, SecretsService, secretPermission } from '@bellis/kernel';
import { SafetyService } from '@bellis/safety';
import { Alignment, type Synthesis, type Tts, TtsService } from '@bellis/speech';
import Type, { type Static } from 'typebox';
import {
  type Engine,
  EngineError,
  type EngineStream,
  type EngineTimeouts,
  RequestError,
  type Vendor,
} from './engine.ts';
import { MinimaxEngine } from './minimax.ts';
import { VolcengineEngine } from './volcengine.ts';

/** 中国大陆的官方端点。清单按这两个主机申请外发权限；改用别的端点须另行授予该主机。 */
export const MINIMAX_ENDPOINT = 'wss://api.minimax.cn/ws/v1/t2a_v2_bidi';
export const VOLCENGINE_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection';

/** 外发权限名。 */
export function egressPermission(host: string): string {
  return `net.egress:${host}`;
}

const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

const VendorName = Type.Union([Type.Literal('minimax'), Type.Literal('volcengine')]);
const Option = Type.Union([VendorName, Type.Literal('subtitles')]);
type Option = Static<typeof Option>;

const MinimaxConfig = Type.Object(
  {
    /** 显式开启外发后才会连接 MiniMax（R-10）。 */
    egress: Type.Boolean({ default: false }),
    endpoint: Type.String({ default: MINIMAX_ENDPOINT }),
    model: Type.String({ default: '' }),
    voiceId: Type.String({ default: '' }),
    sampleRate: Type.Union(
      [8000, 16_000, 22_050, 24_000, 32_000, 44_100].map((rate) => Type.Literal(rate)),
      { default: 24_000 },
    ),
    speed: Type.Number({ minimum: 0.5, maximum: 2, default: 1 }),
    vol: Type.Number({ exclusiveMinimum: 0, maximum: 10, default: 1 }),
    pitch: Type.Integer({ minimum: -12, maximum: 12, default: 0 }),
    /** 空串表示由模型自动判断情绪。 */
    emotion: Type.String({ default: '' }),
    /** 空串表示不指定，例如 `Chinese`。 */
    languageBoost: Type.String({ default: '' }),
    /** `word_streaming` 让时间戳随每段音频到达，被打断时已播部分也有时间戳。 */
    subtitleType: Type.Union(
      [Type.Literal('word_streaming'), Type.Literal('word'), Type.Literal('sentence')],
      { default: 'word_streaming' },
    ),
    /** 空闲时 ping 的间隔：服务端约 120 秒无活动即断开，且不主动 ping。 */
    pingIntervalMs: Type.Integer({ minimum: 1000, default: 30_000 }),
  },
  { default: {} },
);

const VolcengineConfig = Type.Object(
  {
    /** 显式开启外发后才会连接火山引擎（R-10）。 */
    egress: Type.Boolean({ default: false }),
    endpoint: Type.String({ default: VOLCENGINE_ENDPOINT }),
    /** X-Api-Resource-Id，例如 `seed-tts-2.0`。 */
    resourceId: Type.String({ default: 'seed-tts-2.0' }),
    speaker: Type.String({ default: '' }),
    /** 只在声音复刻 2.0 时需要。 */
    model: Type.String({ default: '' }),
    sampleRate: Type.Union(
      [8000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000].map((rate) => Type.Literal(rate)),
      { default: 24_000 },
    ),
    speechRate: Type.Integer({ minimum: -50, maximum: 100, default: 0 }),
    loudnessRate: Type.Integer({ minimum: -50, maximum: 100, default: 0 }),
    /** TTS 2.0、ICL 2.0 用 `subtitle`；TTS 1.0、ICL 1.0 用 `timestamp`。 */
    timestamps: Type.Union([Type.Literal('subtitle'), Type.Literal('timestamp')], {
      default: 'subtitle',
    }),
  },
  { default: {} },
);

export const CloudTtsConfig = Type.Object({
  /** 主引擎。 */
  primary: VendorName,
  /** 主引擎不可用时依次尝试的备选；`subtitles` 表示只出字幕（不发声，字幕按估计的时长显示）。 */
  fallback: Type.Array(Option, { default: [] }),
  /** 引擎失败后这么久内不再尝试它，到期后下一句再试。 */
  retryAfterMs: Type.Integer({ minimum: 0, default: 60_000 }),
  connectTimeoutMs: Type.Integer({ minimum: 1, default: 5000 }),
  firstAudioTimeoutMs: Type.Integer({ minimum: 1, default: 5000 }),
  stallTimeoutMs: Type.Integer({ minimum: 1, default: 5000 }),
  cancelTimeoutMs: Type.Integer({ minimum: 1, default: 2000 }),
  idleCloseMs: Type.Integer({ minimum: 1, default: 60_000 }),
  /** 两段式对齐的插值与只出字幕的显示时长按这个语速估计：一个普通码点的毫秒数。 */
  msPerChar: Type.Number({ exclusiveMinimum: 0, default: 220 }),
  /** 只出字幕时静音帧的采样率。 */
  subtitleSampleRate: Type.Integer({ minimum: 8000, default: 16_000 }),
  minimax: MinimaxConfig,
  volcengine: VolcengineConfig,
});
export type CloudTtsConfig = Static<typeof CloudTtsConfig>;

/**
 * 某家厂商为什么不能用（不连接任何端点就能判断的部分）；能用时返回 undefined。
 * 外发未开启、缺少必需配置、端点不是 wss（本机测试除外）或没有授予该主机的外发权限，都不启用。
 */
export function vendorBlocker(
  vendor: Vendor,
  config: CloudTtsConfig,
  permissions: ReadonlySet<string>,
): string | undefined {
  const options = config[vendor];
  if (!options.egress) return '外发未开启';
  if (vendor === 'minimax' && !config.minimax.model) return '未配置模型';
  if (vendor === 'minimax' && !config.minimax.voiceId) return '未配置音色';
  if (vendor === 'volcengine' && !config.volcengine.resourceId) return '未配置资源 ID';
  if (vendor === 'volcengine' && !config.volcengine.speaker) return '未配置音色';
  let url: URL;
  try {
    url = new URL(options.endpoint);
  } catch {
    return `端点不合法：${options.endpoint}`;
  }
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && LOOPBACK.has(url.hostname))) {
    return '端点须为 wss://（本机测试除外）';
  }
  const permission = egressPermission(url.hostname);
  if (!permissions.has(permission)) return `未授予权限 ${permission}`;
  return undefined;
}

export function engineTimeouts(config: CloudTtsConfig): EngineTimeouts {
  return {
    connectTimeoutMs: config.connectTimeoutMs,
    firstAudioTimeoutMs: config.firstAudioTimeoutMs,
    stallTimeoutMs: config.stallTimeoutMs,
    cancelTimeoutMs: config.cancelTimeoutMs,
    idleCloseMs: config.idleCloseMs,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function empty(sampleRate: number): Synthesis {
  return {
    sampleRate,
    totalSamples: undefined,
    timing: undefined,
    frames: (async function* () {})(),
  };
}

/**
 * 云端 TTS（R-10）：不绑定厂商，直接提供 `tts@1`，内部按厂商适配器接 MiniMax 与火山引擎的双向流式接口。
 *
 * - **外发闸门**：每家厂商只有在 profile 中显式开启外发（`egress`）、配置齐全、端点主机已授予
 *   `net.egress:<主机>` 时才会连接；凭据经宿主的凭据服务按名读取（`secret:minimax`、`secret:volcengine`），
 *   值不写日志、不进事件。只合成发声仲裁交来的、已通过发声前检查的朗读文本。
 * - **主备**：按 `primary`、`fallback` 的顺序取第一个可用的引擎；连接失败、鉴权失败、超时或服务端出错时
 *   这一家进入冷却（`retryAfterMs`），这一句改用下一个；`subtitles` 表示只出字幕。每次换用都记事件
 *   `tts.switched` 并写日志提示操作员，不暗中换音色。
 * - **两段式对齐**（R-11）：句段一到即按字数插值，随后用厂商返回的字/词时间戳细化，合成完成后按实际采样数修正；
 *   `Synthesis` 的映射是活的，仲裁按播放游标换算时读到的就是细化后的结果。
 * - **取消**：中止信号或提前停止读取音频即向厂商发取消指令，之后到达的音频一律丢弃。
 */
export const cloudTts = definePlugin({
  manifest: {
    id: 'tts-cloud',
    version: '0.1.0',
    tier: 'ordinary',
    provides: [TtsService.ref],
    inject: [ClockService.ref, SafetyService.ref, SecretsService.ref],
    permissions: [
      egressPermission(new URL(MINIMAX_ENDPOINT).hostname),
      egressPermission(new URL(VOLCENGINE_ENDPOINT).hostname),
      secretPermission('minimax'),
      secretPermission('volcengine'),
    ],
    process: 'in-process',
    config: CloudTtsConfig,
  },
  activate(ctx) {
    const clock = ctx.service(ClockService);
    const safety = ctx.service(SafetyService);
    const secrets = ctx.service(SecretsService);
    const config = ctx.config;
    const timeouts = engineTimeouts(config);
    const chain = [...new Set<Option>([config.primary, ...config.fallback])];

    const engines = new Map<Vendor, Engine>();
    const blocked = new Map<Option, string>();
    for (const option of chain) {
      if (option === 'subtitles') continue;
      const blocker = vendorBlocker(option, config, ctx.permissions);
      if (blocker) {
        blocked.set(option, blocker);
        ctx.log('tts.engine-unavailable', { engine: option, reason: blocker });
        continue;
      }
      const env = {
        clock,
        secret: () => secrets.read(option),
        log: (event: string, fields: Record<string, unknown>) => ctx.log(event, fields),
      };
      engines.set(
        option,
        option === 'minimax'
          ? new MinimaxEngine(config.minimax, timeouts, env)
          : new VolcengineEngine(config.volcengine, timeouts, env),
      );
    }
    ctx.register(() => {
      for (const engine of engines.values()) engine.close();
    });
    const usable = chain.filter((option) => !blocked.has(option));
    const first = usable[0];
    if (first === undefined) {
      throw new Error(
        `没有可用的 TTS 引擎：${chain.map((o) => `${o} ${blocked.get(o)}`).join('；')}`,
      );
    }

    /** 引擎失败后的冷却截止时刻与原因。 */
    const cooling = new Map<Vendor, { until: number; reason: string }>();
    let current: Option | undefined = config.primary;

    /** 换用另一个引擎（或没有可用的）：记事件并写日志提示操作员。 */
    const use = (next: Option | undefined, reason: string) => {
      if (next === current) return;
      const data = { from: current ?? null, to: next ?? null, reason };
      current = next;
      safety.record('tts.switched', data);
      ctx.log('tts.switched', {
        ...data,
        hint:
          next === undefined
            ? '没有可用的 TTS 引擎，句子不会播出，请操作员处理'
            : next === 'subtitles'
              ? '已改为只出字幕，请操作员留意'
              : `已改用 ${next}，音色会变化，请操作员留意`,
      });
    };
    const fail = (vendor: Vendor, error: unknown) => {
      const reason = message(error);
      cooling.set(vendor, { until: clock.now() + config.retryAfterMs, reason });
      ctx.log('tts.engine-failed', {
        engine: vendor,
        reason,
        auth: error instanceof EngineError && error.auth,
      });
    };
    if (first !== config.primary) use(first, `${config.primary} ${blocked.get(config.primary)}`);

    const subtitlesOnly = (spoken: string, signal: AbortSignal): Synthesis => {
      const rate = config.subtitleSampleRate;
      const alignment = new Alignment(spoken, rate, { msPerChar: config.msPerChar });
      const total = alignment.estimatedSamples;
      alignment.complete(total);
      const frame = Math.max(1, Math.round(rate / 50));
      async function* frames() {
        for (let offset = 0; offset < total; offset += frame) {
          if (signal.aborted) return;
          yield new Int16Array(Math.min(frame, total - offset));
        }
      }
      return {
        sampleRate: rate,
        totalSamples: total,
        timing: alignment.timing,
        frames: frames(),
      };
    };

    const voiced = (
      vendor: Vendor,
      spoken: string,
      stream: EngineStream,
      signal: AbortSignal,
    ): Synthesis => {
      const alignment = new Alignment(spoken, stream.sampleRate, { msPerChar: config.msPerChar });
      async function* frames() {
        let produced = 0;
        try {
          for await (const chunk of stream.chunks) {
            if (chunk.kind === 'words') {
              alignment.refine(chunk.words);
              continue;
            }
            produced += chunk.pcm.length;
            yield chunk.pcm;
          }
        } catch (error) {
          if (!(error instanceof RequestError)) fail(vendor, error);
          throw error;
        }
        if (!signal.aborted) alignment.complete(produced);
      }
      return {
        sampleRate: stream.sampleRate,
        get totalSamples() {
          return alignment.totalSamples;
        },
        get timing() {
          return alignment.timing;
        },
        frames: frames(),
      };
    };

    const tts: Tts = {
      async synthesize(spoken, signal) {
        const skipped: string[] = [];
        for (const option of chain) {
          if (signal.aborted || ctx.signal.aborted) return empty(config.subtitleSampleRate);
          const reason = skipped.join('；');
          if (option === 'subtitles') {
            use('subtitles', reason);
            return subtitlesOnly(spoken, signal);
          }
          const engine = engines.get(option);
          const cool = cooling.get(option);
          if (!engine || (cool && clock.now() < cool.until)) {
            skipped.push(`${option} ${blocked.get(option) ?? cool?.reason ?? '不可用'}`);
            continue;
          }
          let stream: EngineStream;
          try {
            stream = await engine.start(spoken, signal);
          } catch (error) {
            if (error instanceof RequestError) throw error;
            fail(option, error);
            skipped.push(`${option} ${message(error)}`);
            continue;
          }
          if (signal.aborted) return empty(stream.sampleRate);
          cooling.delete(option);
          const recovered = current === undefined || chain.indexOf(option) < chain.indexOf(current);
          use(option, recovered ? `${option} 恢复可用` : reason);
          return voiced(option, spoken, stream, signal);
        }
        const reason = skipped.join('；');
        use(undefined, reason);
        throw new Error(`没有可用的 TTS 引擎：${reason}`);
      },
    };
    ctx.provide(TtsService, tts);
  },
});
