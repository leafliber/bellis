import {
  ClockService,
  definePlugin,
  egressAllowed,
  egressPermission,
  SecretsService,
  secretPermission,
} from '@bellis/kernel';
import { SafetyService } from '@bellis/safety';
import {
  Alignment,
  CloudTtsService,
  type Synthesis,
  type TtsEngine,
  TtsExpiredError,
} from '@bellis/speech';
import Type, { type Static } from 'typebox';
import {
  type Engine,
  EngineError,
  type EngineStream,
  type EngineTimeouts,
  RateLimitError,
  RequestError,
  type Vendor,
} from './engine.ts';
import { MinimaxEngine } from './minimax.ts';
import { VolcengineEngine } from './volcengine.ts';

/** 中国大陆的官方端点。清单按这两个主机申请外发权限；改用别的端点须另行授予该主机。 */
export const MINIMAX_ENDPOINT = 'wss://api.minimax.cn/ws/v1/t2a_v2_bidi';
export const VOLCENGINE_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection';

const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

const VendorName = Type.Union([Type.Literal('minimax'), Type.Literal('volcengine')]);

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
    /**
     * 每分钟请求数上限（按句计）：最近 60 秒内已发出这么多句时，下一句安静等到窗口里空出名额再发（R-10）。
     * 缺省按充值用户的 20 RPM；免费用户为 10。
     */
    rpm: Type.Integer({ minimum: 1, default: 20 }),
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
  /** 主引擎不可用时尝试的另一家；两家都不可用时由 `tts-router` 改用下一个引擎或只出字幕。 */
  fallback: Type.Array(VendorName, { default: [] }),
  /** 引擎失败后这么久内不再尝试它，到期后下一句再试。 */
  retryAfterMs: Type.Integer({ minimum: 0, default: 60_000 }),
  connectTimeoutMs: Type.Integer({ minimum: 1, default: 5000 }),
  firstAudioTimeoutMs: Type.Integer({ minimum: 1, default: 5000 }),
  stallTimeoutMs: Type.Integer({ minimum: 1, default: 5000 }),
  cancelTimeoutMs: Type.Integer({ minimum: 1, default: 2000 }),
  idleCloseMs: Type.Integer({ minimum: 1, default: 60_000 }),
  /** 两段式对齐的插值按这个语速估计：一个普通码点的毫秒数。 */
  msPerChar: Type.Number({ exclusiveMinimum: 0, default: 220 }),
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
  if (!egressAllowed(url.hostname, permissions)) {
    return `未授予权限 ${egressPermission(url.hostname)}`;
  }
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
 * 云端 TTS（R-10）：不绑定厂商，提供云端引擎 `tts.cloud@1`（由 `tts-router` 选用），
 * 内部按厂商适配器接 MiniMax 与火山引擎的双向流式接口。
 *
 * - **外发闸门**：每家厂商只有在 profile 中显式开启外发（`egress`）、配置齐全、端点主机已授予
 *   `net.egress:<主机>` 时才会连接；凭据经宿主的凭据服务按名读取（`secret:minimax`、`secret:volcengine`），
 *   值不写日志、不进事件。只合成发声仲裁交来的、已通过发声前检查的朗读文本。
 * - **主备**：按 `primary`、`fallback` 的顺序取第一个可用的厂商；连接失败、鉴权失败、超时或服务端出错时
 *   这一家进入冷却（`retryAfterMs`），这一句改用另一家。换了一家（音色会变化）时记事件 `tts.switched`
 *   并写日志提示操作员。两家都不可用时合成以错误结束、引擎报告未就绪，由路由改用下一个引擎或只出字幕。
 * - **限流**：MiniMax 到了每分钟请求数上限时，这一句在适配器里安静等到额度恢复（R-10）：不冷却、不换厂商，
 *   引擎照常报告就绪，状态里写明正在等待；已经出声之后才被限流的那一句以错误结束，同样不冷却。额度恢复时
 *   这一句所属的发言已过期就不等，以 `TtsExpiredError` 结束，不换厂商、不冷却。
 * - **两段式对齐**（R-11）：句段一到即按字数插值，随后用厂商返回的字/词时间戳细化，合成完成后按实际采样数修正；
 *   `Synthesis` 的映射是活的，仲裁按播放游标换算时读到的就是细化后的结果。
 * - **取消**：中止信号或提前停止读取音频即向厂商发取消指令，之后到达的音频一律丢弃。
 */
export const cloudTts = definePlugin({
  manifest: {
    id: 'tts-cloud',
    version: '0.2.0',
    tier: 'ordinary',
    provides: [CloudTtsService.ref],
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
    const chain = [...new Set<Vendor>([config.primary, ...config.fallback])];

    const engines = new Map<Vendor, Engine>();
    const blocked = new Map<Vendor, string>();
    for (const vendor of chain) {
      const blocker = vendorBlocker(vendor, config, ctx.permissions);
      if (blocker) {
        blocked.set(vendor, blocker);
        ctx.log('tts.engine-unavailable', { engine: vendor, reason: blocker });
        continue;
      }
      const env = {
        clock,
        secret: () => secrets.read(vendor),
        log: (event: string, fields: Record<string, unknown>) => ctx.log(event, fields),
      };
      engines.set(
        vendor,
        vendor === 'minimax'
          ? new MinimaxEngine(config.minimax, timeouts, env)
          : new VolcengineEngine(config.volcengine, timeouts, env),
      );
    }
    ctx.register(() => {
      for (const engine of engines.values()) engine.close();
    });
    const usable = chain.filter((vendor) => !blocked.has(vendor));
    const first = usable[0];
    if (first === undefined) {
      throw new Error(
        `没有可用的云端 TTS 引擎：${chain.map((v) => `${v} ${blocked.get(v)}`).join('；')}`,
      );
    }

    /** 引擎失败后的冷却截止时刻与原因。 */
    const cooling = new Map<Vendor, { until: number; reason: string }>();
    /** 上一次出声的厂商：换了一家时提示操作员（音色会变化）。 */
    let current: Vendor = config.primary;

    const use = (next: Vendor, reason: string) => {
      if (next === current) return;
      const data = { from: current, to: next, reason };
      current = next;
      safety.record('tts.switched', data);
      ctx.log('tts.switched', { ...data, hint: `已改用 ${next}，音色会变化，请操作员留意` });
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

    /** 某家此刻为什么不能用；能用时返回 undefined。 */
    const unavailable = (vendor: Vendor): string | undefined => {
      if (!engines.has(vendor)) return blocked.get(vendor) ?? '不可用';
      const cool = cooling.get(vendor);
      if (cool && clock.now() < cool.until) return `冷却中（${cool.reason}）`;
      return undefined;
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
          // 文本被拒是这一句的问题，限流不是故障：都不冷却。
          if (!(error instanceof RequestError || error instanceof RateLimitError)) {
            fail(vendor, error);
          }
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

    const engine: TtsEngine = {
      get ready() {
        return !ctx.signal.aborted && chain.some((vendor) => unavailable(vendor) === undefined);
      },
      get status() {
        const available = chain.filter((vendor) => unavailable(vendor) === undefined);
        if (available.length === 0) {
          return chain.map((vendor) => `${vendor} ${unavailable(vendor)}`).join('；');
        }
        const waiting = available.flatMap((vendor) => {
          const wait = engines.get(vendor)?.waiting;
          if (!wait) return [];
          const seconds = Math.max(0, Math.ceil((wait.until - clock.now()) / 1000));
          const why = wait.reason === '1002' ? '厂商限流' : '本地计数到每分钟上限';
          return [`${vendor} 等待限流（${why}，约 ${seconds} 秒）`];
        });
        return [`可用：${available.join('、')}`, ...waiting].join('；');
      },
      async synthesize(spoken, signal, options) {
        const skipped: string[] = [];
        for (const vendor of chain) {
          if (signal.aborted || ctx.signal.aborted) return empty(config[vendor].sampleRate);
          const blocker = unavailable(vendor);
          const found = engines.get(vendor);
          if (blocker !== undefined || !found) {
            skipped.push(`${vendor} ${blocker ?? '不可用'}`);
            continue;
          }
          let stream: EngineStream;
          try {
            stream = await found.start(spoken, signal, options);
          } catch (error) {
            // 文本被拒、限流额度到发言过期之后才恢复：都不换厂商、不冷却。
            if (error instanceof RequestError || error instanceof TtsExpiredError) throw error;
            fail(vendor, error);
            skipped.push(`${vendor} ${message(error)}`);
            continue;
          }
          if (signal.aborted) return empty(stream.sampleRate);
          cooling.delete(vendor);
          const recovered = chain.indexOf(vendor) < chain.indexOf(current);
          use(vendor, recovered ? `${vendor} 恢复可用` : skipped.join('；'));
          return voiced(vendor, spoken, stream, signal);
        }
        const reason = skipped.join('；');
        ctx.log('tts.engine-unavailable', { engine: 'cloud', reason });
        throw new Error(`没有可用的云端 TTS 引擎：${reason}`);
      },
    };
    ctx.provide(CloudTtsService, engine);
  },
});
