import type { Signal, SignalPriorityClass } from "@bellis/contracts";

/**
 * 确定性优先级分类（phase-3-development-guide.md §6.1/§6.3）：
 * 分类只依赖 Signal 自身字段（priority 阈值 + kind 目录），
 * 不调用主模型、不看队列状态。
 */
export interface SignalPriorityPolicy {
  /** signal.priority ≥ 阈值 → urgent。 */
  readonly urgentPriorityThreshold: number;
  /** 无条件 urgent 的 kind 目录（如平台封禁通知、管理员指令）。 */
  readonly urgentKinds: readonly string[];
}

export const DEFAULT_PRIORITY_POLICY: SignalPriorityPolicy = {
  urgentPriorityThreshold: 800,
  urgentKinds: ["moderator_command"],
};

export function classifySignal(signal: Signal, policy: SignalPriorityPolicy): SignalPriorityClass {
  if (policy.urgentKinds.includes(signal.kind)) {
    return "urgent";
  }
  return signal.priority >= policy.urgentPriorityThreshold ? "urgent" : "normal";
}
