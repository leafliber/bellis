/**
 * Outbox 重试策略（docs/protocols/persistence-and-recovery.md）：有上限的指数退避 + 确定性抖动。
 *
 * 抖动由 (jitterSeed, attempts) 经整数散列确定性导出——相同种子下
 * 任意次重放得到相同序列，测试可精确断言 available_at_ms。
 * delay = min(maxMs, baseMs · 2^attempts) · (1 + jitter)，最终再钳到 maxMs。
 */

export interface OutboxRetryPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly maxAttempts: number;
  readonly jitterSeed: number;
}

export const DEFAULT_OUTBOX_RETRY_POLICY: OutboxRetryPolicy = {
  baseMs: 100,
  maxMs: 30_000,
  maxAttempts: 8,
  jitterSeed: 0x1e11_5,
};

/** [0, 1) 的确定性伪随机：整数散列后取 2^30 刻度。 */
export function deterministicJitter(seed: number, attempts: number): number {
  let state = (seed ^ (attempts * 0x9e37_79b9)) >>> 0;
  state = Math.imul(state ^ (state >>> 16), 0x21f0_aaad) >>> 0;
  state = Math.imul(state ^ (state >>> 15), 0x735a_2d97) >>> 0;
  state = (state ^ (state >>> 15)) >>> 0;
  return (state / 2 ** 30) % 1;
}

/** 第 attempts 次失败后的重试延迟（毫秒）。 */
export function computeRetryDelayMs(policy: OutboxRetryPolicy, attempts: number): number {
  const exp = policy.baseMs * 2 ** Math.min(attempts, 30);
  const capped = Math.min(policy.maxMs, exp);
  const jitter = deterministicJitter(policy.jitterSeed, attempts);
  return Math.min(policy.maxMs, Math.round(capped * (1 + jitter * 0.25)));
}

/** 是否进入 Dead Letter：不可重试，或尝试次数已达上限。 */
export function shouldDeadLetter(
  policy: OutboxRetryPolicy,
  attempts: number,
  retryable: boolean,
): boolean {
  return !retryable || attempts >= policy.maxAttempts;
}
