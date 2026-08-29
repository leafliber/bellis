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
export { ScriptedModelProvider } from "./model/scripted-provider.js";
export { StreamAssembler } from "./model/stream-assembler.js";
export type {
  AssemblerError,
  AssemblerErrorCode,
  AssemblerOutcome,
  ModelUsage,
  ToolArgumentValidator,
} from "./model/stream-assembler.js";
export type {
  CycleAdoptionInput,
  CycleAdoptionPort,
  PerformancePort,
  PerformanceSubmitContext,
  PerformanceSubmitResult,
} from "./loop/ports.js";
export { DecisionLoop, DEFAULT_DECISION_LOOP_CONFIG } from "./loop/decision-loop.js";
export type { DecisionLoopConfig, DecisionLoopOptions, TurnResult } from "./loop/decision-loop.js";
export type { DecisionAuditPort } from "./loop/audit.js";
export { buildSafetyPacket, DEFAULT_DEGRADATION_POLICY } from "./loop/degradation.js";
export type { DegradationPolicy, DegradationReason } from "./loop/degradation.js";
export { buildModelRequest, packetDigest, MAX_PROMPT_CHARS } from "./loop/request-assembly.js";

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
