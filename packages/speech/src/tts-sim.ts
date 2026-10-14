import { ClockService, definePlugin, sleep } from '@bellis/kernel';
import Type from 'typebox';
import { type Synthesis, TtsService } from './types.ts';

/**
 * 模拟 TTS：每个朗读码点固定若干采样，给出精确的时间映射，用于验证截断与写回逻辑。
 * 可以让首包延迟、让音频比实时更慢地产生（用于制造欠载）。
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
    }),
  },
  activate(ctx) {
    const clock = ctx.service(ClockService);
    const { sampleRate, samplesPerChar, frameSamples, firstChunkDelayMs, slowness, withoutTiming } =
      ctx.config;
    ctx.provide(TtsService, {
      async synthesize(spoken, signal): Promise<Synthesis> {
        const chars = [...spoken];
        const total = chars.length * samplesPerChar;
        const frameMs = (frameSamples * 1000) / sampleRate;
        async function* frames() {
          if (firstChunkDelayMs > 0) await sleep(clock, firstChunkDelayMs);
          for (let offset = 0; offset < total; offset += frameSamples) {
            if (signal.aborted) return;
            if (slowness > 0) await sleep(clock, frameMs * slowness);
            yield new Int16Array(Math.min(frameSamples, total - offset));
          }
        }
        return {
          sampleRate,
          timing: withoutTiming
            ? undefined
            : chars.map((_, i) => ({ sample: i * samplesPerChar, char: i })),
          frames: frames(),
        };
      },
    });
  },
});
