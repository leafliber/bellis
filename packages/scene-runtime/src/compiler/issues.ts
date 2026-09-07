import type { CueLane } from "@bellis/contracts";

/**
 * 编译期稳定问题码（docs/archive/phase-2/development-guide.md §6.1）。
 * 闭合集合：新增码属于兼容变更，但必须先更新协议/开发指南文档。
 */
export const COMPILE_ISSUE_CODES = [
  "cue_limit_exceeded",
  "hard_lane_unsatisfiable",
  "capability_missing",
  "anchor_unresolved",
  "lane_conflict",
  "plan_invalid",
] as const;

export type CompileIssueCode = (typeof COMPILE_ISSUE_CODES)[number];

export interface CompileIssue {
  readonly code: CompileIssueCode;
  readonly message: string;
  /** 问题关联的 Lane（能力/同步类问题）。 */
  readonly lane?: CueLane;
  /** 问题关联的意图 ID（Avatar/Game/Overlay 意图）。 */
  readonly intentId?: string;
}
