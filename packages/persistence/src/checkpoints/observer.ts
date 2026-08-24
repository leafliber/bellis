/**
 * 受控检查点观察器（docs/phase-1-reference.md；docs/protocols/persistence-and-recovery.md）。
 *
 * - 公开装配可选注入，生产默认 No-op；未启用时事务顺序与性能语义不变。
 * - 测试适配器只能由测试父进程通过继承的私有 IPC 创建（test/fixtures），
 *   生产入口不导出“启用故障”的便利函数，HTTP/WS 无 Fault Route，
 *   普通环境变量也不能远程开启。
 */

export const PERSISTENCE_CHECKPOINTS = [
  "before_scene_transaction_commit",
  "after_scene_transaction_commit_before_outbox_dispatch",
  "after_outbox_publish_before_mark_delivered",
] as const;

export type PersistenceCheckpoint = (typeof PERSISTENCE_CHECKPOINTS)[number];

export interface PersistenceCheckpointContext {
  readonly traceId: string;
  readonly sceneId?: string;
  readonly outboxId?: string;
}

/**
 * 到达检查点时回调；signal 在请求 Deadline 或 Client 关闭时中止。
 * 正常返回继续执行；抛出错误则当前事务/批次回滚或放弃。
 */
export interface PersistenceCheckpointObserver {
  reached(
    checkpoint: PersistenceCheckpoint,
    context: PersistenceCheckpointContext,
    signal: AbortSignal,
  ): Promise<void>;
}

function noopReached(): Promise<void> {
  return Promise.resolve();
}

/** 生产默认实现：不注册任何检查点行为。 */
export function createNoopCheckpointObserver(): PersistenceCheckpointObserver {
  return { reached: noopReached };
}
