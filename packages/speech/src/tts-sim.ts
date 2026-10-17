import { ClockService, definePlugin, sleep } from '@bellis/kernel';
import Type from 'typebox';
import { Alignment } from './timing.ts';
import { type Synthesis, TtsService } from './types.ts';

/**
 * 模拟 TTS：每个朗读码点固定若干采样，给出精确的时间映射，用于验证截断与写回逻辑。
 * 可以让首包延迟、让音频比实时更慢地产生（用于制造欠载）。
 * `twoStage` 时模拟云端 TTS 的两段式对齐（R-11）：句段一到先给插值映射，每产出一帧，
 * 用已经开始的码点的精确时间戳细化，合成完成后填上总采样数。
 * 缺省输出静音；给出 `toneHz` 时输出正弦测试音，用于在真实 OBS 里听到、测到 Stage 的声音。
 */
export const simTts = definePlugin({
  manifest: {
    id: 'tts-sim',
    version: '0.1.0',
    tier: 'ordinary',
    provides: [TtsService.ref],
    inject: [ClockService.ref],
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
    }),
  },
  activate(ctx) {
    const clock = ctx.service(ClockService);
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
    } = ctx.config;
    const msOf = (samples: number) => (samples * 1000) / sampleRate;
    ctx.provide(TtsService, {
      async synthesize(spoken, signal): Promise<Synthesis> {
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
