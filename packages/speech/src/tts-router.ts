import { definePlugin, type ServiceToken } from '@bellis/kernel';
import { SafetyService } from '@bellis/safety';
import Type from 'typebox';
import { Alignment } from './timing.ts';
import {
  CloudTtsService,
  LocalTtsService,
  type Synthesis,
  type Tts,
  type TtsEngine,
  type TtsOption,
  TtsRequestError,
  type TtsRouting,
  TtsRoutingService,
  TtsService,
} from './types.ts';

const ENGINES: Readonly<Record<Exclude<TtsOption, 'subtitles'>, ServiceToken<TtsEngine>>> = {
  local: LocalTtsService,
  cloud: CloudTtsService,
};

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
 * TTS 路由（R-10）：提供 `tts@1`，按 profile 配置的顺序（`order`）选第一个就绪的引擎。
 *
 * - 引擎是可选依赖（`tts.local@1`、`tts.cloud@1`）：引擎崩溃、未就绪或不在时跳过它，`tts@1` 不消失，
 *   发声仲裁照常运行，不因此急停。
 * - 引擎合成失败时这一句改用下一个；引擎以文本本身为由拒绝的句子（`TtsRequestError`）不换引擎，这一句失败。
 * - `subtitles` 表示只出字幕：给出与估计朗读时长等长的静音帧和对应的插值映射，Stage 照常显示字幕、
 *   回报游标，仲裁与 Stage 不区分这种模式。
 * - 每次换用都记事件 `tts.switched`（从哪个到哪个、原因）并写日志提示操作员，不暗中换音色。
 */
export const ttsRouter = definePlugin({
  manifest: {
    id: 'tts-router',
    version: '0.1.0',
    tier: 'ordinary',
    provides: [TtsService.ref, TtsRoutingService.ref],
    inject: [SafetyService.ref, `${LocalTtsService.ref}?`, `${CloudTtsService.ref}?`],
    permissions: [],
    process: 'in-process',
    config: Type.Object({
      /** 依次尝试的引擎；`subtitles` 之后的项不会被用到。 */
      order: Type.Array(
        Type.Union([Type.Literal('local'), Type.Literal('cloud'), Type.Literal('subtitles')]),
        { minItems: 1, uniqueItems: true },
      ),
      /** 只出字幕时的显示时长按这个语速估计：一个普通码点的毫秒数。 */
      msPerChar: Type.Number({ exclusiveMinimum: 0, default: 220 }),
      /** 只出字幕时静音帧的采样率。 */
      subtitleSampleRate: Type.Integer({ minimum: 8000, default: 16_000 }),
    }),
  },
  activate(ctx) {
    const safety = ctx.service(SafetyService);
    const config = ctx.config;
    const order = config.order;
    const engine = (option: Exclude<TtsOption, 'subtitles'>) => ctx.optional(ENGINES[option]);
    // 起初认为在用配置中的第一项：首句就用它时不算换用。
    let current: TtsOption | undefined = order[0];

    /** 换用另一个引擎（或没有可用的）：记事件并写日志提示操作员。 */
    const use = (next: TtsOption | undefined, reason: string) => {
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
      return { sampleRate: rate, totalSamples: total, timing: alignment.timing, frames: frames() };
    };

    const tts: Tts = {
      async synthesize(spoken, signal) {
        const skipped: string[] = [];
        for (const option of order) {
          if (signal.aborted || ctx.signal.aborted) return empty(config.subtitleSampleRate);
          const reason = skipped.join('；');
          if (option === 'subtitles') {
            use('subtitles', reason);
            return subtitlesOnly(spoken, signal);
          }
          const found = engine(option);
          if (!found) {
            skipped.push(`${option} 不在`);
            continue;
          }
          if (!found.ready) {
            skipped.push(`${option} ${found.status}`);
            continue;
          }
          let synthesis: Synthesis;
          try {
            synthesis = await found.synthesize(spoken, signal);
          } catch (error) {
            if (error instanceof TtsRequestError) throw error;
            skipped.push(`${option} ${message(error)}`);
            continue;
          }
          const recovered = current === undefined || order.indexOf(option) < order.indexOf(current);
          use(option, recovered ? `${option} 恢复可用` : reason);
          return synthesis;
        }
        const reason = skipped.join('；');
        use(undefined, reason);
        throw new Error(`没有可用的 TTS 引擎：${reason}`);
      },
    };

    const routing: TtsRouting = {
      primary() {
        const first = order.find((option) => option !== 'subtitles');
        if (first === undefined) return undefined;
        const found = engine(first);
        return found
          ? { engine: first, ready: found.ready, status: found.status }
          : { engine: first, ready: false, status: '不在' };
      },
    };
    ctx.provide(TtsService, tts);
    ctx.provide(TtsRoutingService, routing);
  },
});
