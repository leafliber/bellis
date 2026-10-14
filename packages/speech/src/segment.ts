import type { Sentence } from './types.ts';

const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '；', ';', '\n']);
const CLAUSE_END = new Set(['，', '、', ',', '：', ':']);
const DIGITS = '零一二三四五六七八九';
/** 不朗读的符号。 */
const SILENT = /[~～*#_`|<>[\]{}()（）「」『』【】《》"'“”‘’…—-]/u;

export interface SegmenterOptions {
  /** 首句在第一个分句处切开的最少码点数。 */
  firstClauseMin?: number;
  /** 一句的最多码点数，超过时在最后一个分句处或直接切开。 */
  maxLength?: number;
}

/**
 * 分句：在语义完整的边界（句末标点、换行）切句；首句在第一个分句处切开以缩短开口时间；
 * 过长的句子在分句处切开。每句生成字幕文本与朗读文本（数字逐字读、去掉不朗读的符号）。
 */
export class Segmenter {
  #buffer = '';
  #index = 0;
  readonly #firstClauseMin: number;
  readonly #maxLength: number;

  constructor(options: SegmenterOptions = {}) {
    this.#firstClauseMin = options.firstClauseMin ?? 4;
    this.#maxLength = options.maxLength ?? 60;
  }

  push(text: string): Sentence[] {
    this.#buffer += text;
    const out: Sentence[] = [];
    for (let cut = this.#nextCut(false); cut > 0; cut = this.#nextCut(false)) {
      this.#emit(cut, out);
    }
    return out;
  }

  /** 文本流结束：剩余部分作为最后一句。 */
  flush(): Sentence[] {
    const out: Sentence[] = [];
    for (let cut = this.#nextCut(true); cut > 0; cut = this.#nextCut(true)) this.#emit(cut, out);
    return out;
  }

  #nextCut(final: boolean): number {
    const chars = [...this.#buffer];
    if (chars.length === 0) return 0;
    let lastClause = -1;
    for (let i = 0; i < chars.length; i += 1) {
      const c = chars[i] as string;
      if (SENTENCE_END.has(c)) return cutAfterPunctuation(chars, i);
      if (CLAUSE_END.has(c)) {
        lastClause = i;
        if (this.#index === 0 && i + 1 >= this.#firstClauseMin)
          return cutAfterPunctuation(chars, i);
      }
      if (i + 1 >= this.#maxLength)
        return lastClause >= 0 ? cutAfterPunctuation(chars, lastClause) : i + 1;
    }
    return final ? chars.length : 0;
  }

  #emit(cut: number, out: Sentence[]): void {
    const chars = [...this.#buffer];
    const subtitle = chars.slice(0, cut).join('').trim();
    this.#buffer = chars.slice(cut).join('');
    if (!subtitle) return;
    const { spoken, align } = speakable(subtitle);
    if (!spoken.trim()) return;
    out.push({ index: this.#index, subtitle, spoken, align });
    this.#index += 1;
  }
}

/** 把紧跟的句末标点（例如“！？”）并入同一句。 */
function cutAfterPunctuation(chars: string[], at: number): number {
  let end = at + 1;
  while (end < chars.length && (SENTENCE_END.has(chars[end] as string) || chars[end] === '”'))
    end += 1;
  return end;
}

/** 由字幕文本生成朗读文本，并记录朗读文本每个码点对应的字幕码点下标。 */
export function speakable(subtitle: string): { spoken: string; align: number[] } {
  const chars = [...subtitle];
  let spoken = '';
  const align: number[] = [];
  chars.forEach((c, index) => {
    let out = c;
    if (c >= '0' && c <= '9') out = DIGITS[Number(c)] as string;
    else if (SILENT.test(c)) out = '';
    for (const s of out) {
      spoken += s;
      align.push(index);
    }
  });
  return { spoken, align };
}

/**
 * 按播放游标算出观众实际听到的字幕前缀：只计入已完整播出的朗读码点。
 * 没有时间映射时返回 undefined（只能按整句计）。
 */
export function heardPrefix(
  sentence: Sentence,
  played: number,
  timing: ReadonlyArray<{ sample: number; char: number }> | undefined,
  totalSamples: number | undefined,
): string | undefined {
  if (!timing) return undefined;
  const spoken = [...sentence.spoken];
  let heardChars = 0;
  for (let i = 0; i < spoken.length; i += 1) {
    const next = timing.find((t) => t.char === i + 1)?.sample ?? totalSamples;
    if (next === undefined || next > played) break;
    heardChars = i + 1;
  }
  if (heardChars === 0) return '';
  const lastSubtitle = sentence.align[heardChars - 1] as number;
  return [...sentence.subtitle].slice(0, lastSubtitle + 1).join('');
}
