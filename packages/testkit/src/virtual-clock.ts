import type { MonotonicClock } from "@bellis/contracts";

/**
 * 确定性虚拟单调时钟（phase-1-build-guide.md §7.1，Gate 1 交付）。
 *
 * - 测试手动推进时间，不调用真实 setTimeout 等待业务时长。
 * - nowUs 永不倒退；advance 到更早时间会抛错。
 * - sleepUntil：目标已过立即完成；AbortSignal 以取消原因拒绝；
 *   多个等待者按目标时间升序释放（相同目标按注册顺序）；
 *   大步推进时一次释放所有到期任务。
 *
 * 本文件是 Gate 1 冻结契约：P3 只能使用，不能修改其行为。
 */

interface Waiter {
  readonly targetUs: bigint;
  readonly sequence: number;
  resolve(): void;
  reject(reason: unknown): void;
  /** Abort 监听清理函数；未注册监听时为 null。 */
  detach(): void;
}

export class VirtualClock implements MonotonicClock {
  #currentUs = 0n;
  #waiters: Waiter[] = [];
  #registrationCounter = 0;

  nowUs(): bigint {
    return this.#currentUs;
  }

  sleepUntil(targetUs: bigint, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    if (targetUs <= this.#currentUs) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const registration = this.#registrationCounter;
      this.#registrationCounter += 1;
      const waiter: Waiter = {
        targetUs,
        sequence: registration,
        resolve,
        reject,
        detach: () => {
          signal?.removeEventListener("abort", onAbort);
        },
      };
      const onAbort = () => {
        this.#remove(waiter);
        reject(signal?.reason ?? new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#insert(waiter);
    });
  }

  /** 推进到绝对微秒时间；到期等待者按目标升序一次性全部释放。 */
  advance(toUs: bigint): void {
    if (toUs < this.#currentUs) {
      throw new RangeError(
        `VirtualClock cannot move backwards (current=${this.#currentUs}, target=${toUs})`,
      );
    }
    this.#currentUs = toUs;
    const due: Waiter[] = [];
    while (this.#waiters[0] !== undefined && this.#waiters[0].targetUs <= toUs) {
      const waiter = this.#waiters.shift();
      if (waiter !== undefined) {
        due.push(waiter);
      }
    }
    for (const waiter of due) {
      waiter.detach();
      waiter.resolve();
    }
  }

  /** 相对当前时间推进 deltaUs 微秒。 */
  advanceBy(deltaUs: bigint): void {
    this.advance(this.#currentUs + deltaUs);
  }

  /** 当前挂起的等待者数量，用于断言队列状态。 */
  pendingCount(): number {
    return this.#waiters.length;
  }

  /** 队列始终保持按（目标时间, 注册顺序）升序；相同目标按注册顺序排列。 */
  #insert(waiter: Waiter): void {
    const index = this.#waiters.findIndex((existing) => existing.targetUs > waiter.targetUs);
    this.#waiters.splice(index === -1 ? this.#waiters.length : index, 0, waiter);
  }

  #remove(waiter: Waiter): void {
    const index = this.#waiters.indexOf(waiter);
    if (index !== -1) {
      this.#waiters.splice(index, 1);
    }
  }
}
