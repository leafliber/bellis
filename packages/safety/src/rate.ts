import type { Clock } from '@bellis/kernel';

export interface RateLimit {
  max: number;
  windowMs: number;
}

/** 按能力计数的滑动窗口限速。 */
export class RateLimiter {
  readonly #clock: Clock;
  readonly #limits: Readonly<Record<string, RateLimit>>;
  readonly #hits = new Map<string, number[]>();

  constructor(clock: Clock, limits: Readonly<Record<string, RateLimit>>) {
    this.#clock = clock;
    this.#limits = limits;
  }

  /** 全部能力都未超限时计入一次并返回 undefined；否则返回超限的能力，不计入。 */
  take(capabilities: readonly string[]): string | undefined {
    const now = this.#clock.now();
    for (const capability of capabilities) {
      const limit = this.#limits[capability];
      if (!limit) continue;
      const recent = (this.#hits.get(capability) ?? []).filter((t) => now - t < limit.windowMs);
      this.#hits.set(capability, recent);
      if (recent.length >= limit.max) return capability;
    }
    for (const capability of capabilities) {
      if (this.#limits[capability]) this.#hits.get(capability)?.push(now);
    }
    return undefined;
  }
}
