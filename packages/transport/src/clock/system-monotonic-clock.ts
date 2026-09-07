import { BaseMonotonicClock } from "./base-monotonic-clock.js";

/**
 * 生产单调时钟（docs/reference/phase-1.md，P1 交付；仅服务端/Node）。
 *
 * - nowUs 基于 process.hrtime.bigint() 从纳秒整除到微秒（bigint 域，无浮点）。
 * - 等待/关闭语义见 BaseMonotonicClock（与浏览器时钟共享同一实现）。
 * - 本文件属于 Node-only 入口：浏览器 Bundle 必须使用 ./browser 入口的
 *   BrowserMonotonicClock（Phase 2 Browser Bundle Spike，ADR 0003）。
 */
export class SystemMonotonicClock extends BaseMonotonicClock {
  constructor() {
    super("system_monotonic_clock_closed");
  }

  nowUs(): bigint {
    return process.hrtime.bigint() / 1000n;
  }
}
