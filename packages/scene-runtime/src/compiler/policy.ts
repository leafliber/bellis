/**
 * 编译策略（docs/phase-2-development-guide.md §6.1）。
 *
 * - 不支持的能力在编译期返回稳定 Issue；非 hard lane 是否降级（omit
 *   该 Cue）由策略决定，hard lane 不可满足一律拒绝（指南 §6.1 冻结）。
 * - Phase 2 的"整组降级"由应用层实现：Director 取消原 Scene 后，
 *   应用可用收窄的输入重新编译并提交**新的** Scene；commit 协议不表达
 *   部分 Cue 生效（ADR 0003 / scene-execution.md §6）。
 */
export interface CompilePolicy {
  /**
   * 非 hard lane 缺能力时的处置："reject" 整帧拒绝（默认，保守）；
   * "omit" 丢弃对应 Cue 并记录 advisory。
   */
  readonly missingCapability: "reject" | "omit";
  /** 单 Scene Cue 数上限（≤ ScenePlanSchema 的 64）。 */
  readonly maxCues: number;
  /** Scene.deadlineMs（Prepare/Commit 最大等待时长）。 */
  readonly defaultDeadlineMs: number;
}

export const DEFAULT_COMPILE_POLICY: CompilePolicy = {
  missingCapability: "reject",
  maxCues: 64,
  defaultDeadlineMs: 500,
};

export function resolveCompilePolicy(overrides?: Partial<CompilePolicy>): CompilePolicy {
  const policy = { ...DEFAULT_COMPILE_POLICY, ...overrides };
  if (!Number.isInteger(policy.maxCues) || policy.maxCues < 1 || policy.maxCues > 64) {
    throw new RangeError("policy.maxCues must be an integer in [1, 64]");
  }
  if (!Number.isInteger(policy.defaultDeadlineMs) || policy.defaultDeadlineMs < 1) {
    throw new RangeError("policy.defaultDeadlineMs must be a positive integer");
  }
  if (policy.missingCapability !== "reject" && policy.missingCapability !== "omit") {
    throw new RangeError("policy.missingCapability must be 'reject' or 'omit'");
  }
  return policy;
}
