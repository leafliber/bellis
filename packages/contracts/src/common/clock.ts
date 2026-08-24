/**
 * 生产时钟与测试时钟共同的最小接口（docs/phase-1-reference.md）。
 *
 * Contracts 只定义能力，不包含实现：
 * - 生产实现 SystemMonotonicClock 由 @bellis/transport 交付（P1）。
 * - 确定性测试实现 VirtualClock 已由 @bellis/testkit 在 Gate 1 交付。
 *
 * 语义约束：
 * - nowUs 基于单调时钟（如 process.hrtime.bigint() 转微秒），永不倒退，
 *   且禁止比较不同进程的原始单调时间。
 * - sleepUntil 在 targetUs 已过时立即完成；AbortSignal 触发时以取消原因拒绝；
 *   多个等待者按目标时间升序释放；大步推进时一次释放所有到期任务。
 */
export interface MonotonicClock {
  nowUs(): bigint;
  sleepUntil(targetUs: bigint, signal?: AbortSignal): Promise<void>;
}
