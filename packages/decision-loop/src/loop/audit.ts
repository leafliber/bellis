import type { DegradationReason } from "./degradation.js";

/**
 * Decision Loop 审计 Port：宿主（P4）把事件落为版本化 Session Record
 * （phase3_turn_started / phase3_turn_finished / phase3_model_request /
 * phase3_cycle_finished；cycle adopted 由 CycleAdoptionPort 同事务写入）。
 * 事件为 fire-and-forget：审计失败不得阻塞决策路径（宿主自行记录失败）。
 */
export interface DecisionAuditPort {
  turnStarted(payload: {
    readonly turnId: string;
    readonly trigger: "normal_batch" | "interrupt" | "next_turn";
    readonly batchId: string;
  }): void;
  turnFinished(payload: {
    readonly turnId: string;
    readonly result: "completed" | "cancelled" | "failed" | "degraded";
    readonly cycleCount: number;
    readonly reason?: string;
  }): void;
  modelRequest(payload: {
    readonly cycleId: string;
    readonly provider: string;
    readonly outcome: "final" | "degraded" | "failed" | "aborted";
    readonly degradationReason?: DegradationReason;
    readonly ttftMs?: number;
    readonly durationMs?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cachedInputTokens?: number;
  }): void;
  cycleFinished(payload: {
    readonly turnId: string;
    readonly cycleId: string;
    readonly result: "completed" | "cancelled" | "failed";
    readonly next: "finish" | "after_tools" | "continue";
    readonly sceneSubmitted: boolean;
  }): void;
}
