/**
 * @bellis/persistence — SQLite DB Worker、Migration、Session Records、
 * 原子提交与 Outbox（P2 交付）。
 *
 * `node:sqlite` 只能在 src/worker/database.ts 导入；主线程通过版本化
 * 类型化 RPC 操作（docs/phase-1-reference.md），不允许任意 SQL 穿过
 * Worker 边界。公开装配：createPersistenceClient / createOutboxDispatcher。
 */

export {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  isRetryableCode,
  toSafePersistenceError,
} from "./errors.js";
export type {
  PersistenceErrorCode,
  PersistenceErrorOptions,
  SafePersistenceError,
} from "./errors.js";

export { PERSISTENCE_CHECKPOINTS, createNoopCheckpointObserver } from "./checkpoints/observer.js";
export type {
  PersistenceCheckpoint,
  PersistenceCheckpointContext,
  PersistenceCheckpointObserver,
} from "./checkpoints/observer.js";

export type {
  AdvanceServerSeqInput,
  AppendRecordInput,
  ClaimOutboxInput,
  CommitSceneInput,
  CommitSceneResult,
  CompleteOutboxInput,
  EnsureSessionInput,
  ListRecordsInput,
  ActiveSceneRow,
  OutboxRetryDisposition,
  OutboxRetryPolicyConfig,
  OutboxStats,
  PersistenceClient,
  PersistenceClientOptions,
  PersistenceRpcDiagnostic,
  PersistenceWorkerOptions,
  RecoveryState,
  RetryOutboxInput,
} from "./client/persistence-client.js";
export { createPersistenceClient } from "./client/persistence-client.js";
export type {
  Phase3AdoptCycleInput,
  Phase3AppendSignalInput,
  Phase3AppendSignalOutcome,
  Phase3DecisionState,
  Phase3RestoreState,
  Phase3ToolCacheSetInput,
  Phase3ToolRunEventInput,
} from "./client/persistence-client.js";

export { createOutboxDispatcher } from "./outbox/dispatcher.js";
export type {
  OutboxDispatchRunSummary,
  OutboxDispatcher,
  OutboxDispatcherOptions,
  OutboxPublishResult,
  OutboxPublisher,
} from "./outbox/dispatcher.js";

export type { ConfirmEffectInput, ConfirmedSpeech } from "./repositories/phase4-effects.js";

export {
  MINIMUM_COMPLETION_HEADROOM_BYTES,
  DISK_ADMISSION_WRITE_MARGIN_BYTES,
} from "./disk-admission.js";
export type { PersistenceDiskAdmissionOptions, PersistenceDiskStatus } from "./disk-admission.js";

export type {
  HistoryInventoryBegin,
  HistoryInventory,
  HistoryInventoryPageInput,
  HistoryInventoryPage,
  HistoryInventoryItemInput,
  HistoryInventoryItem,
} from "./repositories/phase4-history-inventory.js";

export type { RecallRequestWrite } from "./repositories/phase4-recall-requests.js";

export type {
  HistoryVerificationBatch,
  HistoryVerificationPage,
} from "./repositories/phase4-history-verification.js";

export type {
  HistoryRecoveryInput,
  HistoryRecoveryState,
} from "./repositories/phase4-history-inventory.js";
