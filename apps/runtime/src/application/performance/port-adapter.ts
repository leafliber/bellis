import type { DecisionPacket } from "@bellis/contracts";
import type {
  PerformancePort,
  PerformanceSubmitContext,
  PerformanceSubmitResult,
} from "@bellis/decision-loop";
import type { Phase2PerformanceService } from "../phase-2/performance-service.js";

/**
 * 演出提交 Port 适配器（phase-3-development-guide.md §9.1）：
 * 把「已采用 DecisionPacket」的稳定应用边界（@bellis/decision-loop 的
 * PerformancePort）适配到 Phase2PerformanceService.submitDecision——
 * 复用 Action Compiler、Fake TTS/媒体发送器、Scene Director 与回执；
 * Phase 2 的 submit(Fake Signal + Fixture) 入口原路径保留。
 */
export class PerformancePortAdapter implements PerformancePort {
  readonly #service: Phase2PerformanceService;

  constructor(service: Phase2PerformanceService) {
    this.#service = service;
  }

  submitDecision(
    packet: DecisionPacket,
    context: PerformanceSubmitContext,
  ): PerformanceSubmitResult {
    const outcome = this.#service.submitDecision(packet, context.traceId);
    if (outcome.kind === "submitted") {
      return {
        kind: "scene_submitted",
        sceneId: outcome.sceneId,
        done: outcome.handle.done.then(
          () => "completed" as const,
          () => "failed" as const,
        ),
      };
    }
    if (outcome.kind === "noop") {
      return { kind: "noop" };
    }
    if (outcome.kind === "rejected") {
      return { kind: "compile_rejected", issues: outcome.issues };
    }
    return { kind: "noop" };
  }

  async interruptActiveScenes(reason: string): Promise<void> {
    await this.#service.interruptAll(reason);
  }
}
