import type { Envelope, FromPage } from '@bellis/stage';

export interface MouthOptions {
  /** 两次游标回报之间按墙钟外推的上限（毫秒）。 */
  extrapolateMaxMs: number;
  /** RMS（相对 16 位满幅）不高于它即闭嘴。 */
  rmsFloor: number;
  /** RMS 不低于它即全开；其间线性。 */
  rmsCeiling: number;
}

/** 同时留着的句子数上限（推迟期间至多上一句与这一句）。 */
const MAX_SPEAKING = 4;

interface Speaking {
  sentenceId: string;
  /** 这一句的响度包络：开始播放时从 Stage 取到就留着，播完后推迟的那段时间里还要用。 */
  envelope: Envelope | undefined;
  /** 页面开始播这一句的时刻。 */
  startedAt: number;
  /** 最近一次回报的已播采样数。 */
  played: number;
  /** 收到那次回报的时刻。 */
  at: number;
  /** 欠载中：页面在补零，嘴闭上，直到游标再次前进。 */
  stalled: boolean;
  /** 页面回报播完的时刻。 */
  endedAt: number | undefined;
}

/**
 * 口型：按 Stage 回报的播放游标在响度包络上取值，映射到 0–1。
 * 位置取最近一次游标回报的采样数，加上按墙钟外推的时间（不超过上限）；只跟随游标，不跟随文本或音频的到达。
 * 取值时可以给一个推迟量（呈现延迟减去形象自身的时延，见 Stage 文档“对齐”）：取的是那么久之前的位置，
 * 播完的句子也推迟那么久才闭嘴。欠载、截断与页面静音立即闭嘴，不推迟。
 */
export class MouthTracker {
  readonly #options: MouthOptions;
  readonly #envelope: (sentenceId: string) => Envelope | undefined;
  /** 按开始的先后；推迟期间上一句还没收尾时，下一句可能已经开始。 */
  #speaking: Speaking[] = [];

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
        this.#speaking = this.#speaking.filter((s) => s.sentenceId !== event.sentenceId);
        this.#speaking.push({
          sentenceId: event.sentenceId,
          envelope: this.#envelope(event.sentenceId),
          startedAt: now,
          played: 0,
          at: now,
          stalled: false,
          endedAt: undefined,
        });
        // 页面没回报结束就断开的句子不会再有回报：只留最近几句。
        if (this.#speaking.length > MAX_SPEAKING) this.#speaking.shift();
        return;
      case 'cursor':
      case 'underrun': {
        let speaking = this.#speaking.find((s) => s.sentenceId === event.sentenceId);
        if (!speaking) {
          // 形象启动时句子已在播放：从游标接上，开始时刻不详。
          speaking = {
            sentenceId: event.sentenceId,
            envelope: this.#envelope(event.sentenceId),
            startedAt: Number.NEGATIVE_INFINITY,
            played: event.played,
            at: now,
            stalled: false,
            endedAt: undefined,
          };
          this.#speaking.push(speaking);
          if (this.#speaking.length > MAX_SPEAKING) this.#speaking.shift();
        }
        speaking.stalled =
          event.kind === 'underrun' || (speaking.stalled && event.played <= speaking.played);
        speaking.played = event.played;
        speaking.at = now;
        speaking.envelope ??= this.#envelope(event.sentenceId);
        return;
      }
      case 'ended': {
        const speaking = this.#speaking.find((s) => s.sentenceId === event.sentenceId);
        if (speaking) speaking.endedAt = now;
        return;
      }
      case 'truncated':
        this.#speaking = this.#speaking.filter((s) => s.sentenceId !== event.sentenceId);
        return;
      case 'muted':
        this.#speaking = [];
        return;
      case 'heartbeat-ack':
        return;
    }
  }

  /**
   * 此刻嘴张开的幅度，0–1。
   * @param lagMs 推迟量（毫秒，不小于 0）：取 `now - lagMs` 时刻的位置。
   */
  value(now: number, lagMs = 0): number {
    const t = now - Math.max(0, lagMs);
    // 推迟之后也已播完的句子不再需要。
    this.#speaking = this.#speaking.filter((s) => s.endedAt === undefined || s.endedAt > t);
    const speaking = this.#speaking.findLast((s) => s.startedAt <= t);
    if (!speaking || speaking.stalled) return 0;
    const envelope = speaking.envelope ?? this.#envelope(speaking.sentenceId);
    if (!envelope) return 0;
    speaking.envelope = envelope;
    // 推迟时 t 可能早于最近一次回报：游标按采样率前进，往回推同样成立。
    const elapsed = Math.min(t - speaking.at, this.#options.extrapolateMaxMs);
    const position = speaking.played + (elapsed * envelope.sampleRate) / 1000;
    if (position < 0) return 0;
    const rms = envelope.rms[Math.floor(position / envelope.window)];
    if (rms === undefined) return 0;
    const { rmsFloor, rmsCeiling } = this.#options;
    return Math.min(1, Math.max(0, (rms - rmsFloor) / (rmsCeiling - rmsFloor)));
  }
}
