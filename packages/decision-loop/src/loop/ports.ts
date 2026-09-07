import type { DecisionPacket, ContextAdoption } from "@bellis/contracts";

/**
 * Decision Loop 的宿主侧 Port（P0 草案；P4 由 Runtime/Persistence 实现）。
 *
 * 循环内不 import Fastify、SQLite、Stage 或具体 Model SDK：所有外部
 * 效果经这两个 Port 注入（phase-3-development-guide.md §4）。
 */

/**
 * Cycle adoption：最终包校验通过后的原子采用操作（ADR 0004）。
 *
 * 实现必须在单个事务内写入：
 * - cycle adopted Record（cycleId、包摘要、batch/水位、turn 状态、
 *   Trace 身份）；
 * - 消费水位推进（watermarkFrom→watermarkTo）；
 * - 将要执行的 Tool Run planned 行（含幂等键摘要）；
 * - 必要的 Outbox/审计记录。
 *
 * 任一写入失败 → 整个事务回滚 → adoption 失败：Loop 必须取消全部
 * Prepare、不推进水位、不执行可变 Tool、不提交 Scene。
 */
export interface CycleAdoptionInput {
  /** Frozen trusted Turn identity; absent only for legacy direct callers. */
  readonly sessionId?: string;
  readonly context?: ContextAdoption;
  readonly turnId: string;
  readonly cycleId: string;
  readonly cycleIndex: number;
  readonly packet: DecisionPacket;
  /** packet 的 SHA-256 hex 摘要（审计 Record 用）。 */
  readonly packetDigest: string;
  readonly batchId: string;
  readonly watermarkFrom: bigint;
  readonly watermarkTo: bigint;
  readonly degraded: boolean;
  readonly traceId: string;
}

export interface CycleAdoptionPort {
  adoptCycle(input: CycleAdoptionInput): Promise<void>;
}

/** 演出提交上下文：Scene 路径的取消域与 Trace。 */
export interface PerformanceSubmitContext {
  readonly traceId: string;
  readonly turnId: string;
  readonly cycleId: string;
  readonly cycleIndex: number;
  /** Scene 取消域（Turn 取消时中断可中断 Scene）。 */
  readonly signal: AbortSignal;
}

export type PerformanceSubmitResult =
  | {
      readonly kind: "scene_submitted";
      readonly sceneId: string;
      /** Scene 终态（completed/cancelled/failed）；由 Director 结算。 */
      readonly done: Promise<"completed" | "cancelled" | "failed">;
    }
  /** noOp 或无可执行行动：不依赖 Scene Commit 即可消费水位。 */
  | { readonly kind: "noop" }
  /** 编译拒绝：如实返回 issues；水位照常推进（不变量 8/9）。 */
  | { readonly kind: "compile_rejected"; readonly issues: readonly { readonly code: string }[] };

/**
 * 演出提交 Port：接收「已采用 DecisionPacket」的稳定应用边界
 * （P4 从 Phase2PerformanceService 抽出；Phase 2 兼容入口保留）。
 */
export interface PerformancePort {
  submitDecision(
    packet: DecisionPacket,
    context: PerformanceSubmitContext,
  ): PerformanceSubmitResult;
  /** 中断当前可中断 Scene（interrupt 路径；不绕过 Scene Director）。 */
  interruptActiveScenes(reason: string): Promise<void>;
}
