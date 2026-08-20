import type { MonotonicClock } from "@bellis/contracts";

/**
 * 生产单调时钟（phase-1-build-guide.md §7.1，P1 交付）。
 *
 * - nowUs 基于 process.hrtime.bigint() 从纳秒整除到微秒（bigint 域，无浮点）。
 * - 等待只依赖单调时间：setTimeout 仅作唤醒 hints，到期后以 hrtime 复核，
 *   系统墙钟跳变（NTP、休眠）不会提前或永久推迟释放。
 * - 目标已过立即完成；AbortSignal 触发以取消原因拒绝；多个并发等待互不影响。
 * - 超过 setTimeout 上限（2^31-1 ms）的等待分段调度。
 * - close() 拒绝所有挂起等待并拒绝新等待，供 Runtime 关闭序列使用。
 */

/** setTimeout 的最大安全延迟（毫秒）。 */
const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

interface ClockWaiter {
  fail(reason: unknown): void;
  detach(): void;
}

export class SystemMonotonicClock implements MonotonicClock {
  #closed = false;
  readonly #waiters = new Set<ClockWaiter>();

  nowUs(): bigint {
    return process.hrtime.bigint() / 1000n;
  }

  sleepUntil(targetUs: bigint, signal?: AbortSignal): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error("system_monotonic_clock_closed"));
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error("aborted"));
    }
    if (targetUs <= this.nowUs()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const detach = () => {
        this.#waiters.delete(waiter);
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (onAbort !== undefined) {
          signal?.removeEventListener("abort", onAbort);
        }
      };
      const settleReject = (reason: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        detach();
        reject(reason);
      };
      const waiter: ClockWaiter = { fail: settleReject, detach };
      let onAbort: (() => void) | undefined;
      if (signal !== undefined) {
        onAbort = () => {
          settleReject(signal.reason ?? new Error("aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.#waiters.add(waiter);

      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        detach();
        resolve();
      };
      const schedule = () => {
        const remainingUs = targetUs - this.nowUs();
        if (remainingUs <= 0n) {
          finish();
          return;
        }
        // 向上取整到毫秒，保证不会早于目标时间唤醒。
        const delayMs = Number((remainingUs + 999n) / 1000n);
        timer = setTimeout(onWakeup, Math.min(delayMs, MAX_TIMEOUT_DELAY_MS));
      };
      const onWakeup = () => {
        timer = undefined;
        if (settled) {
          return;
        }
        if (targetUs - this.nowUs() <= 0n) {
          finish();
          return;
        }
        schedule();
      };
      schedule();
    });
  }

  /** 关闭时钟：拒绝全部挂起等待；之后的 sleepUntil 立即拒绝。 */
  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const reason = new Error("system_monotonic_clock_closed");
    // fail() 只会移除当前遍历到的 waiter，Set 迭代期间删除当前元素是安全的。
    for (const waiter of this.#waiters) {
      waiter.fail(reason);
    }
  }
}
