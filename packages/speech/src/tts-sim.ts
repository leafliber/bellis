import {
  ClockService,
  definePlugin,
  sleep,
  sleepUnlessAborted,
  TraceService,
} from '@bellis/kernel';
import Type from 'typebox';
import { Alignment } from './timing.ts';
import { type Synthesis, TtsService } from './types.ts';

/** 模拟限流的计数窗口。 */
const RATE_WINDOW_MS = 60_000;

/**
 * 模拟 TTS：每个朗读码点固定若干采样，给出精确的时间映射，用于验证截断与写回逻辑。
 * 可以让首包延迟、让音频比实时更慢地产生（用于制造欠载）。
 * `twoStage` 时模拟云端 TTS 的两段式对齐（R-11）：句段一到先给插值映射，每产出一帧，
 * 用已经开始的码点的精确时间戳细化，合成完成后填上总采样数。
 * 缺省输出静音；给出 `toneHz` 时输出正弦测试音，用于在真实 OBS 里听到、测到 Stage 的声音。
 * 给出 `rpm` 时模拟云端 TTS 按每分钟请求数限流时的等待：最近 60 秒内已开始合成这么多句时，下一句在返回之前
 * 安静等到窗口里空出名额；等待受中止信号约束（中止即返回空的合成），不计入首包延迟。
 */
export const simTts = definePlugin({
  manifest: {
    id: 'tts-sim',
    version: '0.1.0',
    tier: 'ordinary',
    provides: [TtsService.ref],
    inject: [ClockService.ref, `${TraceService.ref}?`],
    permissions: [],
    process: 'in-process',
    config: Type.Object({
      sampleRate: Type.Integer({ minimum: 1, default: 16_000 }),
      samplesPerChar: Type.Integer({ minimum: 1, default: 3200 }),
      frameSamples: Type.Integer({ minimum: 1, default: 320 }),
      firstChunkDelayMs: Type.Integer({ minimum: 0, default: 0 }),
      /** 每帧产生所需的时间与该帧时长之比；大于 1 时音频产生得比播放慢，会欠载。 */
      slowness: Type.Number({ minimum: 0, default: 0 }),
      /** 不给时间映射，模拟只能按整句计的 TTS。 */
      withoutTiming: Type.Boolean({ default: false }),
      /** 先插值、再随音频逐字细化的映射（模拟流式时间戳）。 */
      twoStage: Type.Boolean({ default: false }),
      /** 两段式时插值用的语速估计（每个普通码点的毫秒数），故意与实际语速不同。 */
      estimateMsPerChar: Type.Number({ exclusiveMinimum: 0, default: 120 }),
      /** 朗读文本含这些片段时，合成在第一帧之后出错（模拟 TTS 中途失败）。 */
      failOn: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
      /** 大于 0 时输出该频率、振幅 0.2 的正弦测试音。 */
      toneHz: Type.Number({ minimum: 0, default: 0 }),
      /** 大于 0 时模拟每分钟请求数上限（按句计，窗口 60 秒）。 */
      rpm: Type.Integer({ minimum: 0, default: 0 }),
    }),
  },
  activate(ctx) {
    const clock = ctx.service(ClockService);
    const trace = ctx.optional(TraceService);
    const {
      sampleRate,
      samplesPerChar,
      frameSamples,
      firstChunkDelayMs,
      slowness,
      withoutTiming,
      twoStage,
      estimateMsPerChar,
      failOn,
      toneHz,
      rpm,
    } = ctx.config;
    /** 最近一个窗口内开始合成的时刻（升序）。 */
    const started: number[] = [];
    /** 到了每分钟上限就等到窗口里空出名额：可以开始时返回 true，等待中被中止时返回 false。 */
    const slot = async (signal: AbortSignal): Promise<boolean> => {
      let waited = false;
      for (;;) {
        const now = clock.now();
        while (started.length > 0 && (started[0] as number) <= now - RATE_WINDOW_MS) {
          started.shift();
        }
        if (started.length < rpm) {
          if (waited) trace?.record('tts.rate-wait-ended', { canceled: false });
          return true;
        }
        const ms = (started[started.length - rpm] as number) + RATE_WINDOW_MS - now;
        if (!waited) trace?.record('tts.rate-wait', { ms });
        waited = true;
        if (!(await sleepUnlessAborted(clock, ms, signal))) {
          trace?.record('tts.rate-wait-ended', { canceled: true });
          return false;
        }
      }
    };
    const msOf = (samples: number) => (samples * 1000) / sampleRate;
    ctx.provide(TtsService, {
      async synthesize(spoken, signal): Promise<Synthesis> {
        if (rpm > 0) {
          if (!(await slot(signal))) {
            return {
              sampleRate,
              totalSamples: undefined,
              timing: undefined,
              frames: (async function* () {})(),
            };
          }
          started.push(clock.now());
        }
        const chars = [...spoken];
        const total = chars.length * samplesPerChar;
        const frameMs = (frameSamples * 1000) / sampleRate;
        const alignment = twoStage
          ? new Alignment(spoken, sampleRate, { msPerChar: estimateMsPerChar })
          : undefined;
        async function* frames() {
          if (firstChunkDelayMs > 0) await sleep(clock, firstChunkDelayMs);
          for (let offset = 0; offset < total; offset += frameSamples) {
            if (signal.aborted) return;
            if (slowness > 0) await sleep(clock, frameMs * slowness);
            const frame = new Int16Array(Math.min(frameSamples, total - offset));
            if (toneHz > 0) {
              for (let i = 0; i < frame.length; i++) {
                frame[i] = Math.round(
                  6553 * Math.sin((2 * Math.PI * toneHz * (offset + i)) / sampleRate),
                );
              }
            }
            if (alignment) {
              // 这一帧里已经开始的码点都有了时间戳（与音频一起到达，像流式时间戳那样）。
              const started = Math.min(
                chars.length,
                Math.ceil((offset + frame.length) / samplesPerChar),
              );
              alignment.refine(
                chars.slice(0, started).map((text, i) => ({
                  text,
                  startMs: msOf(i * samplesPerChar),
                  endMs: msOf((i + 1) * samplesPerChar),
                })),
              );
            }
            yield frame;
            if (failOn.some((word) => spoken.includes(word))) throw new Error('模拟 TTS 中途出错');
          }
          alignment?.complete(total);
        }
        if (alignment) {
          return {
            sampleRate,
            get totalSamples() {
              return alignment.totalSamples;
            },
            get timing() {
              return alignment.timing;
            },
            frames: frames(),
          };
        }
        return {
          sampleRate,
          totalSamples: total,
          timing: withoutTiming
            ? undefined
            : chars.map((_, i) => ({ sample: i * samplesPerChar, char: i })),
          frames: frames(),
        };
      },
    });
  },
});
