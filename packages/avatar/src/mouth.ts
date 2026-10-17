import type { Envelope, FromPage } from '@bellis/stage';

export interface MouthOptions {
  /** 两次游标回报之间按墙钟外推的上限（毫秒）。 */
  extrapolateMaxMs: number;
  /** RMS（相对 16 位满幅）不高于它即闭嘴。 */
  rmsFloor: number;
  /** RMS 不低于它即全开；其间线性。 */
  rmsCeiling: number;
}

interface Speaking {
  sentenceId: string;
  /** 最近一次回报的已播采样数。 */
  played: number;
  /** 收到那次回报的时刻。 */
  at: number;
  /** 欠载中：页面在补零，嘴闭上，直到游标再次前进。 */
  stalled: boolean;
}

/**
 * 口型：按 Stage 回报的播放游标在响度包络上取值，映射到 0–1。
 * 位置取最近一次游标回报的采样数，加上按墙钟外推的时间（不超过上限）；欠载、句子结束或截断、
 * 页面静音时为 0。只跟随游标，不跟随文本或音频的到达。
 */
export class MouthTracker {
  readonly #options: MouthOptions;
  readonly #envelope: (sentenceId: string) => Envelope | undefined;
  #speaking: Speaking | undefined;

  constructor(options: MouthOptions, envelope: (sentenceId: string) => Envelope | undefined) {
    if (!(options.rmsCeiling > options.rmsFloor)) {
      throw new Error('rmsCeiling 必须大于 rmsFloor');
    }
    this.#options = options;
    this.#envelope = envelope;
  }

  onEvent(event: FromPage, now: number): void {
    switch (event.kind) {
      case 'started':
        this.#speaking = { sentenceId: event.sentenceId, played: 0, at: now, stalled: false };
        return;
      case 'cursor':
      case 'underrun': {
        const previous =
          this.#speaking?.sentenceId === event.sentenceId ? this.#speaking : undefined;
        const stalled =
          event.kind === 'underrun' ||
          (previous?.stalled === true && event.played <= previous.played);
        this.#speaking = { sentenceId: event.sentenceId, played: event.played, at: now, stalled };
        return;
      }
      case 'ended':
      case 'truncated':
        if (this.#speaking?.sentenceId === event.sentenceId) this.#speaking = undefined;
        return;
      case 'muted':
        this.#speaking = undefined;
        return;
      case 'heartbeat-ack':
        return;
    }
  }

  /** 此刻嘴张开的幅度，0–1。 */
  value(now: number): number {
    const speaking = this.#speaking;
    if (!speaking || speaking.stalled) return 0;
    const envelope = this.#envelope(speaking.sentenceId);
    if (!envelope) return 0;
    const elapsed = Math.min(Math.max(0, now - speaking.at), this.#options.extrapolateMaxMs);
    const position = speaking.played + (elapsed * envelope.sampleRate) / 1000;
    const rms = envelope.rms[Math.floor(position / envelope.window)];
    if (rms === undefined) return 0;
    const { rmsFloor, rmsCeiling } = this.#options;
    return Math.min(1, Math.max(0, (rms - rmsFloor) / (rmsCeiling - rmsFloor)));
  }
}
