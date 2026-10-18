/**
 * 逐字推进的字幕（Stage 文档“字幕”）：在录像里量每句第一个字出现、最后一个字出现（显示完）与清除的时刻，
 * 各自相对音频。
 *
 * - 区域：给了单行字幕的几何（layout.ts）时只看这一句整行的行框（居中，宽度按字数），否则看整个字幕带。
 * - 每句只看与前后句段之间的中点为界的时间窗；窗口开头那一帧（此时不该有字幕）作这一句的局部参考。
 * - 事件：相邻两帧之间行框里亮度差超过 32 级的像素占比超过阈值（安静帧里这个占比的 p99 的 1.5 倍、
 *   6 倍稳健标准差与 0.3% 中最大的那个）的帧；相邻几帧都超过时合成一个事件，时刻取第一帧（两个字在相邻
 *   两帧出现时会被并成一个；测试音每字 150ms，不会发生）。字幕居中，每多一个字整行左移半个字，所以每个字
 *   的出现都是一次明显的事件。与局部参考相差的像素占比变大的事件是“加字”，降到第一个字出现之前的水平
 *   附近的是“清除”。用局部参考而不是全局参考：形象挡住或移动、背景变化时全局参考不对。
 * - 全局参考（离句段 0.4 秒以上的安静帧逐像素取中位数）只用来输出整段的曲线供核对。
 * - 测试音（给出每字秒数 secondsPerChar）：模拟 TTS 每个码点的时长相同，第 k 个字的声音从
 *   出声 + k·每字秒数 开始，按 Stage 的规则这个字在它开始播出时显示。加字事件数等于字数的句子按顺序配对，
 *    其余的句子（有字被挡住）按这一句清除相对声音结束的偏差（看不到清除时用全字可见句子偏差的中位数）
 *   把每个事件配到最近的字（半个字以内），
 *   配不上的字计为“看不到”。给出每个字的偏差、第一个与最后一个字的偏差，以及按字的出现时刻对声音时刻做
 *   线性回归的斜率（推进速率相对音频进度的偏差）与残差。
 * - 真实语音：每字的声音时刻不在录像里，只给第一个字相对出声、最后一个字与清除相对声音结束，以及字幕
 *   推进跨度占音频时长的百分数。
 * 字幕被形象挡住而测不到的字与句子单独计数，不计入偏差。
 */
import { intersect, lineBox, type Rect, type SubtitleLine } from './layout.ts';
import {
  type AudioSegment,
  median,
  percentile,
  quiet,
  robustSd,
  round,
  summarize,
} from './stats.ts';

/** 亮度差超过这么多级才算“变了”。 */
const DIFF = 32;
/** 行框四周的余量（录像像素），容纳文字阴影。 */
const PAD = 4;
/** 事件阈值的下限（行框像素的占比）。 */
const MIN_EVENT = 0.003;
/** 噪声与参考帧最多取这么多帧。 */
const NOISE_FRAMES = 300;
const REFERENCE_FRAMES = 61;

export interface SubtitleFrames {
  /** 实际裁出的字幕带（录像像素）。 */
  rect: Rect;
  width: number;
  height: number;
  times: number[];
  frames: Uint8Array[];
}

export interface SubtitleOptions {
  /** 单行字幕的几何（录像像素）。 */
  line?: SubtitleLine;
  /** 测试音：每个字的秒数。 */
  secondsPerChar?: number;
}

export interface SubtitleSentence {
  /** 测试音按时长推算的字数；语音为 null。 */
  chars: number | null;
  /** 测到的加字事件数。 */
  additions: number;
  /** 第一个字出现 − 它的声音开始（测试音），或 − 出声（语音）；第一个字看不到时为 null。 */
  firstCharMs: number | null;
  /** 第一个看得到的字的序号（测试音）。 */
  firstVisibleChar: number | null;
  /** 最后一个字出现（显示完）− 它的声音开始（测试音），或 − 声音结束（语音）。 */
  lastCharMs: number | null;
  /** 清除 − 声音结束。 */
  clearedMs: number | null;
  /** 看不到的字数（测试音）。 */
  invisibleChars: number | null;
  /** 每个字出现 − 它的声音开始（测试音）；看不到的为 null。 */
  charOffsetsMs: Array<number | null> | null;
  /** 字的出现时刻对声音时刻的回归：斜率偏离 1 的百分数、最大残差、点数（测试音，至少 3 个字）。 */
  rate: { slopePercent: number; residualMaxMs: number; points: number } | null;
  /** 字幕推进跨度（第一个到最后一个加字事件）占音频时长的百分数（语音）。 */
  revealRatio: number | null;
  note?: string;
}

export interface SubtitleAnalysis {
  referenceFrames: number;
  /** 测试音：全字可见的句子的偏差中位数（毫秒），用来给有字看不到的句子配对。 */
  offsetMs: number | null;
  /**
   * 测试音：所有句子合在一起（每句各自扣掉均值）按字的出现时刻对声音时刻回归的斜率偏离 1 的百分数，
   * 与参与的字数。比逐句的斜率稳：帧量化的误差摊到更多的字上。
   */
  pooledRate: { slopePercent: number; chars: number } | null;
  sentences: SubtitleSentence[];
  counts: {
    sentences: number;
    /** 一个字也没看到的句子。 */
    notVisible: number;
    /** 第一个字看不到的句子（测试音）。 */
    firstCharNotVisible: number;
    charsExpected: number;
    charsNotVisible: number;
  };
  /** 整个字幕带每帧与参考帧、与上一帧相差的像素占比，供画曲线核对。 */
  series: { times: number[]; reference: number[]; previous: number[] };
}

interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function regionOf(data: SubtitleFrames, line: SubtitleLine | undefined, chars: number | null) {
  const box = line ? lineBox(line, chars ?? Number.POSITIVE_INFINITY, PAD) : data.rect;
  const r = intersect(box, data.rect) ?? data.rect;
  const clamp = (v: number, hi: number) => Math.min(hi, Math.max(0, v));
  return {
    x0: clamp(Math.floor(r.x - data.rect.x), data.width),
    y0: clamp(Math.floor(r.y - data.rect.y), data.height),
    x1: clamp(Math.ceil(r.x + r.w - data.rect.x), data.width),
    y1: clamp(Math.ceil(r.y + r.h - data.rect.y), data.height),
  };
}

/** 区域里两帧相差超过 DIFF 的像素占比。 */
function changed(a: Uint8Array, b: Uint8Array, width: number, region: Region): number {
  let count = 0;
  for (let y = region.y0; y < region.y1; y++) {
    const row = y * width;
    for (let x = region.x0; x < region.x1; x++) {
      if (Math.abs((a[row + x] ?? 0) - (b[row + x] ?? 0)) > DIFF) count += 1;
    }
  }
  const area = (region.x1 - region.x0) * (region.y1 - region.y0);
  return area > 0 ? count / area : 0;
}

function firstIndexAtOrAfter(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] ?? 0) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface Event {
  t: number;
  before: number;
  after: number;
}

export function analyzeSubtitles(
  data: SubtitleFrames,
  segments: readonly AudioSegment[],
  options: SubtitleOptions = {},
): SubtitleAnalysis {
  const { times, frames, width } = data;
  const quietIndex = times.flatMap((t, k) => (quiet(t, segments) ? [k] : []));
  if (quietIndex.length < 3) throw new Error('录像里没有足够的安静帧作字幕参考');
  const pick = (list: number[], most: number) => {
    const step = Math.max(1, Math.floor(list.length / most));
    return list.filter((_, i) => i % step === 0).slice(0, most);
  };
  const chosen = pick(quietIndex, REFERENCE_FRAMES);
  const size = data.width * data.height;
  const reference = new Uint8Array(size);
  const column = new Uint8Array(chosen.length);
  for (let p = 0; p < size; p++) {
    for (let i = 0; i < chosen.length; i++) column[i] = frames[chosen[i] ?? 0]?.[p] ?? 0;
    column.sort();
    reference[p] = column[column.length >> 1] ?? 0;
  }
  const noiseIndex = pick(
    quietIndex.filter((k) => k > 0),
    NOISE_FRAMES,
  );
  const empty = new Uint8Array(size);
  const frame = (k: number) => frames[k] ?? empty;

  const whole = { x0: 0, y0: 0, x1: data.width, y1: data.height };
  const series = {
    times,
    reference: frames.map((f) => round(changed(f, reference, width, whole), 5)),
    previous: frames.map((f, k) =>
      k === 0 ? 0 : round(changed(f, frame(k - 1), width, whole), 5),
    ),
  };

  const spc = options.secondsPerChar;
  const raw = segments.map((s, i) => {
    const prev = segments[i - 1];
    const next = segments[i + 1];
    const chars = spc ? Math.max(1, Math.round((s.end - s.onset) / spc)) : null;
    const region = regionOf(data, options.line, chars);
    const quietPrevious = noiseIndex.map((k) => changed(frame(k), frame(k - 1), width, region));
    const sorted = [...quietPrevious].sort((a, b) => a - b);
    const threshold = Math.max(
      MIN_EVENT,
      1.5 * (percentile(sorted, 0.99) ?? 0),
      (median(quietPrevious) ?? 0) + 6 * robustSd(quietPrevious),
    );
    // 局部参考：时间窗开头（两句之间的中点，此时不该有字幕）的那一帧。形象挡住或移动、背景变化时，
    // 比全局参考可靠；加字与清除都按与它相差的像素占比判断。
    const from = prev ? (prev.end + s.onset) / 2 : s.onset - 1;
    const to = next ? (s.end + next.onset) / 2 : s.end + 1;
    const events: Event[] = [];
    let run: { start: number; before: number; last: number } | undefined;
    const k0 = Math.max(1, firstIndexAtOrAfter(times, from));
    const local = frame(k0 - 1);
    for (let k = k0; k < times.length && (times[k] ?? 0) <= to; k++) {
      const moved = changed(frame(k), frame(k - 1), width, region);
      if (moved >= threshold) {
        run ??= { start: k, before: changed(frame(k - 1), local, width, region), last: k };
        run.last = k;
      } else if (run) {
        events.push({
          t: times[run.start] ?? 0,
          before: run.before,
          after: changed(frame(run.last), local, width, region),
        });
        run = undefined;
      }
    }
    if (run)
      events.push({
        t: times[run.start] ?? 0,
        before: run.before,
        after: changed(frame(run.last), local, width, region),
      });
    // 清除：降到第一个字出现之前的水平附近（局部的“关”，形象挡住或移动时比全局参考可靠）。
    const additions: Event[] = [];
    let clear: Event | undefined;
    for (const e of events) {
      if (e.after > e.before) additions.push(e);
      else if (additions.length > 0) {
        const base = additions[0]?.before ?? 0;
        if (e.after <= base + 0.3 * (e.before - base)) {
          clear = e;
          break;
        }
      }
    }
    return { s, chars, additions, clear };
  });

  // 测试音：全字可见的句子按顺序配对，求全局偏差。
  let offset: number | null = null;
  if (spc) {
    const complete = raw.flatMap(({ s, chars, additions }) =>
      chars !== null && additions.length === chars
        ? [median(additions.map((a, k) => a.t - (s.onset + k * spc))) ?? 0]
        : [],
    );
    offset = median(complete);
  }

  const ms = (v: number) => round(v * 1000);
  const sentences: SubtitleSentence[] = raw.map(({ s, chars, additions, clear }) => {
    const clearedMs = clear ? ms(clear.t - s.end) : null;
    const base = { chars, additions: additions.length, clearedMs };
    if (spc && chars !== null) {
      const expected = (k: number) => s.onset + k * spc;
      const matched: Array<number | null> = new Array(chars).fill(null);
      if (additions.length === chars) {
        for (const [k, a] of additions.entries()) matched[k] = a.t;
      } else {
        // 清除与加字走同一条路径（页面写 textContent），这一句的偏差先按清除相对声音结束取；
        // 看不到清除时用全局偏差，再不行用最后一个事件对最后一个字。
        const shift =
          (clear ? clear.t - s.end : null) ??
          offset ??
          (additions.length ? (additions.at(-1)?.t ?? 0) - expected(chars - 1) : 0);
        for (const a of additions) {
          const k = Math.round((a.t - shift - s.onset) / spc);
          if (k < 0 || k >= chars || Math.abs(a.t - shift - expected(k)) > spc / 2) continue;
          const current = matched[k];
          const closer =
            current === null ||
            current === undefined ||
            Math.abs(a.t - shift - expected(k)) < Math.abs(current - shift - expected(k));
          if (closer) matched[k] = a.t;
        }
      }
      const charOffsetsMs = matched.map((t, k) => (t === null ? null : ms(t - expected(k))));
      const points = matched.flatMap((t, k) => (t === null ? [] : [[expected(k), t] as const]));
      let rate: SubtitleSentence['rate'] = null;
      if (points.length >= 3) {
        const mx = points.reduce((a, [x]) => a + x, 0) / points.length;
        const my = points.reduce((a, [, y]) => a + y, 0) / points.length;
        const sxx = points.reduce((a, [x]) => a + (x - mx) ** 2, 0);
        const sxy = points.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0);
        const slope = sxy / sxx;
        rate = {
          slopePercent: round((slope - 1) * 100, 2),
          residualMaxMs: ms(
            Math.max(...points.map(([x, y]) => Math.abs(y - (my + slope * (x - mx))))),
          ),
          points: points.length,
        };
      }
      const invisible = matched.filter((t) => t === null).length;
      const firstVisible = matched.findIndex((t) => t !== null);
      return {
        ...base,
        firstCharMs: charOffsetsMs[0] ?? null,
        firstVisibleChar: firstVisible < 0 ? null : firstVisible,
        lastCharMs: charOffsetsMs[chars - 1] ?? null,
        invisibleChars: invisible,
        charOffsetsMs,
        rate,
        revealRatio: null,
        ...(additions.length === 0
          ? { note: '字幕看不到（被挡住或没测出）' }
          : invisible > 0
            ? { note: `${invisible} 个字看不到（被挡住或没测出）` }
            : {}),
      };
    }
    const first = additions[0];
    const last = additions.at(-1);
    return {
      ...base,
      firstCharMs: first ? ms(first.t - s.onset) : null,
      firstVisibleChar: null,
      lastCharMs: last ? ms(last.t - s.end) : null,
      invisibleChars: null,
      charOffsetsMs: null,
      rate: null,
      revealRatio: first && last ? round((100 * (last.t - first.t)) / (s.end - s.onset), 1) : null,
      ...(additions.length === 0 ? { note: '字幕看不到（被挡住或没测出）' } : {}),
    };
  });

  return {
    referenceFrames: chosen.length,
    offsetMs: offset === null ? null : ms(offset),
    pooledRate: spc ? pooled(sentences, spc) : null,
    sentences,
    counts: {
      sentences: sentences.length,
      notVisible: sentences.filter((s) => s.additions === 0).length,
      firstCharNotVisible: sentences.filter((s) => s.chars !== null && s.firstCharMs === null)
        .length,
      charsExpected: sentences.reduce((a, s) => a + (s.chars ?? 0), 0),
      charsNotVisible: sentences.reduce((a, s) => a + (s.invisibleChars ?? 0), 0),
    },
    series,
  };
}

/** 合并回归：偏差 = 出现 − 声音，对声音时刻（句内 k·每字秒数）的斜率即速率偏离；每句扣掉各自的均值。 */
function pooled(
  sentences: readonly SubtitleSentence[],
  spc: number,
): { slopePercent: number; chars: number } | null {
  let sxx = 0;
  let sxy = 0;
  let n = 0;
  for (const s of sentences) {
    const points = (s.charOffsetsMs ?? []).flatMap((o, k) =>
      o === null ? [] : [[k * spc, o / 1000] as const],
    );
    if (points.length < 2) continue;
    const mx = points.reduce((a, [x]) => a + x, 0) / points.length;
    const my = points.reduce((a, [, y]) => a + y, 0) / points.length;
    for (const [x, y] of points) {
      sxx += (x - mx) ** 2;
      sxy += (x - mx) * (y - my);
    }
    n += points.length;
  }
  return sxx > 0 ? { slopePercent: round((sxy / sxx) * 100, 2), chars: n } : null;
}

/** 字幕的汇总：每句的第一个字、最后一个字与清除，测试音另有逐字偏差与推进速率。 */
export function summarizeSubtitles(list: readonly SubtitleSentence[]) {
  return {
    firstCharMs: summarize(list.map((s) => s.firstCharMs)),
    lastCharMs: summarize(list.map((s) => s.lastCharMs)),
    clearedMs: summarize(list.map((s) => s.clearedMs)),
    charMs: summarize(list.flatMap((s) => s.charOffsetsMs ?? [])),
    rateSlopePercent: summarize(list.map((s) => s.rate?.slopePercent ?? null)),
    rateResidualMaxMs: summarize(list.map((s) => s.rate?.residualMaxMs ?? null)),
    revealRatio: summarize(list.map((s) => s.revealRatio)),
  };
}
