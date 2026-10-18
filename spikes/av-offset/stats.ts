/** 录像分析共用的统计小工具。 */

export interface Summary {
  n: number;
  missing: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

export function percentile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? null;
}

/** 样本数、缺失数与分位数（与其它演练的取法一致：第 floor(q·n) 个）。 */
export function summarize(values: ReadonlyArray<number | null>): Summary {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const sorted = [...present].sort((a, b) => a - b);
  const r = (v: number | null) => (v === null ? null : round(v));
  return {
    n: sorted.length,
    missing: values.length - sorted.length,
    min: r(sorted[0] ?? null),
    p50: r(percentile(sorted, 0.5)),
    p95: r(percentile(sorted, 0.95)),
    p99: r(percentile(sorted, 0.99)),
    max: r(sorted.at(-1) ?? null),
  };
}

export function median(values: readonly number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  return percentile(sorted, 0.5);
}

/** 稳健的标准差：中位数绝对偏差乘 1.4826。 */
export function robustSd(values: readonly number[]): number {
  const m = median(values);
  if (m === null) return 0;
  return 1.4826 * (median(values.map((v) => Math.abs(v - m))) ?? 0);
}

/** 句段：出声与结束（秒，录像时间线）。 */
export interface AudioSegment {
  onset: number;
  end: number;
  /** 录像开头或结尾处的句段，可能不完整。 */
  edge: boolean;
}

/** 离句段这么远（秒）才算安静，参考帧与闭合水平都从安静时段取。 */
export const QUIET_MARGIN = 0.4;

export function quiet(t: number, segments: readonly AudioSegment[]): boolean {
  return !segments.some((s) => t >= s.onset - QUIET_MARGIN && t <= s.end + QUIET_MARGIN);
}
