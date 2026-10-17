/** 16 位 PCM 的满幅。 */
const FULL_SCALE = 32768;

/**
 * 一句音频的响度包络：按原始采样率，每 `window` 个采样一个 RMS。下标乘以 `window` 即该窗口起点的采样数，
 * 与播放游标回报的 `played` 同一单位。随音频转发逐步增长。
 */
export interface Envelope {
  readonly sampleRate: number;
  /** 每个窗口的原始采样数。 */
  readonly window: number;
  /** 各窗口的 RMS，相对 16 位满幅归一到 0–1。 */
  readonly rms: readonly number[];
}

/** 边转发边计算响度包络；跨块累计，不满一个窗口的余量在音频结束时补成最后一个窗口。 */
export class EnvelopeBuilder implements Envelope {
  readonly sampleRate: number;
  readonly window: number;
  readonly rms: number[] = [];
  #sum = 0;
  #count = 0;

  constructor(sampleRate: number, windowMs: number) {
    this.sampleRate = sampleRate;
    this.window = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  }

  push(pcm: Int16Array): void {
    for (const sample of pcm) {
      this.#sum += sample * sample;
      this.#count += 1;
      if (this.#count === this.window) this.#flush();
    }
  }

  /** 这一句不会再有音频。 */
  finish(): void {
    if (this.#count > 0) this.#flush();
  }

  #flush(): void {
    this.rms.push(Math.sqrt(this.#sum / this.#count) / FULL_SCALE);
    this.#sum = 0;
    this.#count = 0;
  }
}
