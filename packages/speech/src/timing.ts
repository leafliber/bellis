import type { TimingPoint } from './types.ts';

/** TTS 返回的一个字或词的时间戳：相对这一句音频开头的毫秒。 */
export interface WordStamp {
  text: string;
  startMs: number;
  endMs: number;
}

export interface AlignmentOptions {
  /** 总采样数未知时的语速估计：一个普通码点（权重 1）的毫秒数。 */
  msPerChar: number;
}

/** 句末与分句标点处的停顿，按普通码点的倍数计（R-11 的“标点处加权”）。 */
const SENTENCE_PAUSE = new Set(['。', '！', '？', '!', '?', '；', ';', '…', '\n']);
const CLAUSE_PAUSE = new Set(['，', '、', ',', '：', ':']);
const PUNCTUATION = /[\p{P}\p{S}]/u;
const SPACE = /\s/u;
const ASCII_WORD = /[A-Za-z0-9]/;
/** 半角标点视同全角，比较时不区分。 */
const CANONICAL: Readonly<Record<string, string>> = {
  ',': '，',
  '.': '。',
  '!': '！',
  '?': '？',
  ':': '：',
  ';': '；',
};
/** 找一个字或词时最多向后跳过的码点数；找不到就留给插值，不往远处乱对。 */
const LOOKAHEAD = 8;

/** 插值时一个码点占的时长权重：普通字为 1，标点处加上停顿，拉丁字母与数字读得快。 */
export function charWeight(c: string): number {
  if (SENTENCE_PAUSE.has(c)) return 1.5;
  if (CLAUSE_PAUSE.has(c)) return 1;
  if (SPACE.test(c)) return 0.3;
  if (PUNCTUATION.test(c)) return 0.5;
  if (ASCII_WORD.test(c)) return 0.4;
  return 1;
}

function voiced(c: string): boolean {
  return !SPACE.test(c) && !PUNCTUATION.test(c);
}

function canonical(c: string): string {
  return CANONICAL[c] ?? c.toLowerCase();
}

/** 在 `chars` 中从 `from` 起（至多跳过 LOOKAHEAD 个码点）找 `text`，返回起点或 -1。 */
function locate(chars: readonly string[], from: number, text: readonly string[]): number {
  const last = Math.min(chars.length - text.length, from + LOOKAHEAD);
  for (let at = from; at <= last; at += 1) {
    if (text.every((c, j) => canonical(chars[at + j] as string) === canonical(c))) return at;
  }
  return -1;
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

interface Anchor {
  start: number;
  end: number;
}

/**
 * 一句的两段式时间对齐（R-11）：句段一到就按字数（标点处加权）把朗读文本铺在估计的时长上，
 * 随后用 TTS 返回的字或词时间戳替换能对上的码点，对不上的片段在相邻时间戳之间重新插值；
 * 合成完成、实际总采样数已知后按实际长度修正。
 *
 * 映射始终覆盖朗读文本的每个码点（`timing[i].char === i`），按采样偏移不减。
 * 时间戳的文本逐码点与朗读文本对照（半角与全角标点视同），不依赖厂商的字符偏移。
 */
export class Alignment {
  readonly #chars: readonly string[];
  readonly #weights: readonly number[];
  readonly #sampleRate: number;
  readonly #samplesPerWeight: number;
  #anchors: Array<Anchor | undefined>;
  #total: number | undefined;
  #timing: TimingPoint[] = [];
  #refined = 0;

  constructor(spoken: string, sampleRate: number, options: AlignmentOptions) {
    this.#chars = [...spoken];
    this.#weights = this.#chars.map(charWeight);
    this.#sampleRate = sampleRate;
    this.#samplesPerWeight = (options.msPerChar * sampleRate) / 1000;
    this.#anchors = this.#chars.map(() => undefined);
    this.#rebuild();
  }

  /** 当前的映射：码点 `char` 从第 `sample` 个采样开始。 */
  get timing(): readonly TimingPoint[] {
    return this.#timing;
  }

  /** 实际总采样数；合成完成前为 undefined。 */
  get totalSamples(): number | undefined {
    return this.#total;
  }

  /** 已由时间戳细化的码点数。 */
  get refinedChars(): number {
    return this.#refined;
  }

  /** 按语速估计的整句采样数（用于只出字幕时的显示时长）。 */
  get estimatedSamples(): number {
    return Math.max(1, Math.round(sum(this.#weights) * this.#samplesPerWeight));
  }

  /** 用这一句目前已知的全部时间戳细化（整体替换上一次的结果）。 */
  refine(words: readonly WordStamp[]): void {
    const anchors: Array<Anchor | undefined> = this.#chars.map(() => undefined);
    const toSample = (ms: number) => Math.max(0, Math.round((ms * this.#sampleRate) / 1000));
    let pos = 0;
    for (const word of words) {
      let text = [...word.text].filter((c) => !SPACE.test(c));
      if (text.length === 0) continue;
      let at = locate(this.#chars, pos, text);
      if (at < 0) {
        // 词两端的标点可能与朗读文本不一致：只对齐中间发声的部分。
        let begin = 0;
        let end = text.length;
        while (begin < end && !voiced(text[begin] as string)) begin += 1;
        while (end > begin && !voiced(text[end - 1] as string)) end -= 1;
        text = text.slice(begin, end);
        if (text.length === 0) continue;
        at = locate(this.#chars, pos, text);
        if (at < 0) continue;
      }
      const start = toSample(word.startMs);
      const end = Math.max(start, toSample(word.endMs));
      // 词内按权重分配发声时长；标点不占发声时长，落在它前一个字的结尾。
      const weights = text.map((c) => (voiced(c) ? charWeight(c) : 0));
      const total = sum(weights);
      let acc = 0;
      for (let k = 0; k < text.length; k += 1) {
        const from = total > 0 ? start + ((end - start) * acc) / total : start;
        acc += weights[k] as number;
        const to = total > 0 ? start + ((end - start) * acc) / total : end;
        anchors[at + k] = { start: from, end: to };
      }
      pos = at + text.length;
    }
    this.#anchors = anchors;
    this.#refined = anchors.filter(Boolean).length;
    this.#rebuild();
  }

  /** 合成完成：按实际总采样数修正插值部分。 */
  complete(totalSamples: number): void {
    this.#total = Math.max(0, Math.round(totalSamples));
    this.#rebuild();
  }

  #rebuild(): void {
    const n = this.#chars.length;
    const total = this.#total;
    const clamp = (value: number) => (total === undefined ? value : Math.min(value, total));
    const starts: number[] = new Array(n).fill(0);
    let cursor = 0;
    let i = 0;
    while (i < n) {
      const anchor = this.#anchors[i];
      if (anchor) {
        const start = clamp(Math.max(anchor.start, cursor));
        starts[i] = start;
        cursor = clamp(Math.max(anchor.end, start));
        i += 1;
        continue;
      }
      // 没有时间戳的一段：在左右两侧的时间戳（或句首、句尾）之间按权重插值。
      let j = i;
      while (j < n && !this.#anchors[j]) j += 1;
      const weights = this.#weights.slice(i, j);
      const weight = sum(weights);
      const next = this.#anchors[j];
      let right: number;
      if (next) right = Math.max(cursor, clamp(next.start));
      else if (total !== undefined) right = Math.max(cursor, total);
      else right = cursor + weight * this.#samplesPerWeight;
      let acc = 0;
      for (let k = i; k < j; k += 1) {
        starts[k] = weight > 0 ? cursor + ((right - cursor) * acc) / weight : cursor;
        acc += weights[k - i] as number;
      }
      cursor = right;
      i = j;
    }
    this.#timing = starts.map((start, char) => ({ sample: Math.round(start), char }));
  }
}
