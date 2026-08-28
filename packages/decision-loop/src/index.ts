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

export type { LoopLogger, LoopMetrics } from "./observability.js";

export { classifySignal, DEFAULT_PRIORITY_POLICY } from "./signals/priority.js";
export type { SignalPriorityPolicy } from "./signals/priority.js";
export type { IngestResult } from "./signals/ingress.js";
export { SignalIngress } from "./signals/ingress.js";
export type {
  SignalAppendOutcome,
  SignalRestoreState,
  SignalStoreCapacity,
  SignalStorePort,
} from "./signals/store.js";
export { InMemorySignalStore } from "./signals/store.js";

export { DEFAULT_BATCHER_CONFIG, AudienceBatcher } from "./batcher/audience-batcher.js";
export type { BatchSealInfo, BatchSealTrigger, BatcherConfig } from "./batcher/audience-batcher.js";
export {
  clusterSignals,
  estimateTokens,
  normalizeText,
  readSignalText,
} from "./batcher/cluster.js";
export type { ClusterResult } from "./batcher/cluster.js";

export {
  DEFAULT_TRIGGER_CONFIG,
  DecisionTrigger,
  mergeBatches,
} from "./trigger/decision-trigger.js";
export type {
  DecisionTriggerConfig,
  DecisionTriggerOptions,
  TurnOwnerPort,
} from "./trigger/decision-trigger.js";

export { SignalPipeline } from "./pipeline.js";
export type { SignalPipelineOptions } from "./pipeline.js";
