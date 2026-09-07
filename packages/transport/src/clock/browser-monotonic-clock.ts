import { BaseMonotonicClock } from "./base-monotonic-clock.js";

/**
 * 浏览器单调时钟（Phase 2 Stage，docs/archive/phase-2/development-guide.md §5.6）。
 *
 * - nowUs 基于 performance.now()（毫秒 double）转微秒 bigint：
 *   `Math.round(now * 1000)`。performance.now 是单调时钟（不受系统墙钟
 *   跳变影响），double 精度在常规页面生命周期内足以承载微秒分辨率。
 * - 时间域只属于当前页面：performance.timeOrigin 随页面重载变化，任何
 *   绝对值不得跨连接代际或跨重启比较——跨进程同步一律经
 *   ClockOffsetEstimator 估计偏移，不直接比较原始值。
 * - 等待/关闭语义与 SystemMonotonicClock 共享 BaseMonotonicClock，
 *   浏览器侧不复制等待算法（ADR 0003）。
 */
export class BrowserMonotonicClock extends BaseMonotonicClock {
  constructor() {
    super("browser_monotonic_clock_closed");
  }

  nowUs(): bigint {
    return BigInt(Math.round(performance.now() * 1000));
  }
}
