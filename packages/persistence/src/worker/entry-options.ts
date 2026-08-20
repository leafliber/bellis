/**
 * Worker 侧可序列化配置形态（不依赖主线程类型，随 workerData 传播）。
 */

export interface OutboxRetryPolicyConfigWire {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly maxAttempts: number;
  readonly jitterSeed?: number;
}
