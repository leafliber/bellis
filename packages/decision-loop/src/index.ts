/**
 * @bellis/decision-loop — Signal Pipeline、Decision Trigger 与
 * Decision Loop（Phase 3 / P1、P2）。
 *
 * 公开导出只从本包根暴露；不依赖 Fastify、WebSocket、SQLite、Stage
 * 或具体 Model SDK。
 */
export type {
  ModelProvider,
  ModelRequest,
  ModelSpeechPurpose,
  ModelStreamEvent,
  ModelToolSpec,
} from "./model/provider.js";
export type {
  CycleAdoptionInput,
  CycleAdoptionPort,
  PerformancePort,
  PerformanceSubmitContext,
  PerformanceSubmitResult,
} from "./loop/ports.js";
