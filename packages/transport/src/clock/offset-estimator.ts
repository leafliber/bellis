/**
 * 客户端时钟偏移估计（docs/phase-1-reference.md，P1 交付）。
 *
 * 对每个通过 clock.ping/clock.pong 采得的样本 c0/r1/r2/c3（均为单调微秒）：
 *
 * ```text
 * roundTripUs   = (c3 - c0) - (r2 - r1)
 * runtimeOffsetUs = ((r1 - c0) + (r2 - c3)) / 2      // Runtime 时钟相对本地时钟
 * ```
 *
 * - 全程有符号 bigint 域计算；除法向零截断（最多引入 0.5 µs 系统性偏差）。
 * - 拒绝样本：任一时钟域倒退（c3 < c0 或 r2 < r1）、负 RTT、RTT 超过上限。
 * - 样本窗口有界（FIFO 淘汰）；选择策略确定：按 RTT 升序取前 bestFraction
 *   比例（至少 1 个）组成「最小 RTT 集合」，估计其 Offset 的下中位数，
 *   roundTripUs 取该集合的最小 RTT。高 RTT 样本无法覆盖明显更优样本。
 * - 重连后调用 reset() 清空旧估计并重新校准。
 */

export interface ClockSample {
  readonly c0: bigint;
  readonly r1: bigint;
  readonly r2: bigint;
  readonly c3: bigint;
}

export interface ClockEstimate {
  readonly roundTripUs: bigint;
  readonly runtimeOffsetUs: bigint;
}

export interface ClockOffsetEstimatorOptions {
  /** 单样本 RTT 上限（微秒），超出即丢弃；默认 2 秒。 */
  readonly maxSampleRttUs?: bigint;
  /** 有界样本窗口大小，默认 16，范围 [1, 256]。 */
  readonly windowSize?: number;
  /** 最小 RTT 集合占窗口的比例，默认 0.5，范围 (0, 1]。 */
  readonly bestFraction?: number;
}

interface RecordedSample {
  readonly roundTripUs: bigint;
  readonly runtimeOffsetUs: bigint;
}

const DEFAULT_MAX_SAMPLE_RTT_US = 2_000_000n;
const DEFAULT_WINDOW_SIZE = 16;
const DEFAULT_BEST_FRACTION = 0.5;

export class ClockOffsetEstimator {
  readonly #maxSampleRttUs: bigint;
  readonly #windowSize: number;
  readonly #bestFraction: number;
  #samples: RecordedSample[] = [];

  constructor(options: ClockOffsetEstimatorOptions = {}) {
    const windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
    const bestFraction = options.bestFraction ?? DEFAULT_BEST_FRACTION;
    if (!Number.isInteger(windowSize) || windowSize < 1 || windowSize > 256) {
      throw new RangeError("windowSize must be an integer in [1, 256]");
    }
    if (!(bestFraction > 0 && bestFraction <= 1)) {
      throw new RangeError("bestFraction must be in (0, 1]");
    }
    if ((options.maxSampleRttUs ?? DEFAULT_MAX_SAMPLE_RTT_US) < 0n) {
      throw new RangeError("maxSampleRttUs must be non-negative");
    }
    this.#maxSampleRttUs = options.maxSampleRttUs ?? DEFAULT_MAX_SAMPLE_RTT_US;
    this.#windowSize = windowSize;
    this.#bestFraction = bestFraction;
  }

  /**
   * 加入一个样本。样本非法（时钟域倒退、负 RTT、RTT 超限）时丢弃并返回
   * 当前估计（可能为 null）；否则返回更新后的估计。
   */
  add(sample: ClockSample): ClockEstimate | null {
    if (sample.r2 < sample.r1 || sample.c3 < sample.c0) {
      return this.current();
    }
    const roundTripUs = sample.c3 - sample.c0 - (sample.r2 - sample.r1);
    if (roundTripUs < 0n || roundTripUs > this.#maxSampleRttUs) {
      return this.current();
    }
    const runtimeOffsetUs = (sample.r1 - sample.c0 + (sample.r2 - sample.c3)) / 2n;
    this.#samples.push({ roundTripUs, runtimeOffsetUs });
    if (this.#samples.length > this.#windowSize) {
      this.#samples.splice(0, this.#samples.length - this.#windowSize);
    }
    return this.current();
  }

  /** 当前估计；窗口为空时返回 null。 */
  current(): ClockEstimate | null {
    if (this.#samples.length === 0) {
      return null;
    }
    const byRtt = this.#samples.toSorted((left, right) =>
      left.roundTripUs === right.roundTripUs ? 0 : left.roundTripUs < right.roundTripUs ? -1 : 1,
    );
    const bestCount = Math.max(1, Math.ceil(byRtt.length * this.#bestFraction));
    const best = byRtt.slice(0, bestCount);
    const offsets = best
      .map((sample) => sample.runtimeOffsetUs)
      .toSorted((left, right) => (left === right ? 0 : left < right ? -1 : 1));
    const medianOffsetUs = offsets[Math.floor((offsets.length - 1) / 2)] ?? 0n;
    const minRttUs = best[0]?.roundTripUs ?? 0n;
    return { roundTripUs: minRttUs, runtimeOffsetUs: medianOffsetUs };
  }

  /** 重连后清空旧估计并重新校准。 */
  reset(): void {
    this.#samples = [];
  }

  /** 当前窗口内样本数（测试与诊断用）。 */
  sampleCount(): number {
    return this.#samples.length;
  }
}
