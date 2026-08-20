/**
 * @bellis/persistence — SQLite DB Worker、Migration、Session Records、
 * 原子提交与 Outbox（P2 交付）。
 *
 * `node:sqlite` 只能在 src/worker/database.ts 导入；主线程通过版本化
 * 类型化 RPC 操作（phase-1-build-guide.md §9.1），不允许任意 SQL 穿过
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
  OutboxRetryDisposition,
  OutboxRetryPolicyConfig,
  OutboxStats,
  PersistenceClient,
  PersistenceClientOptions,
  PersistenceMigrationsOverride,
  PersistenceRpcDiagnostic,
  PersistenceWorkerOptions,
  RecoveryState,
  RetryOutboxInput,
} from "./client/persistence-client.js";
export { createPersistenceClient } from "./client/persistence-client.js";

export type { MigrationDefinition } from "./migrations/definition.js";

export { createOutboxDispatcher } from "./outbox/dispatcher.js";
export type {
  OutboxDispatchRunSummary,
  OutboxDispatcher,
  OutboxDispatcherOptions,
  OutboxPublishResult,
  OutboxPublisher,
} from "./outbox/dispatcher.js";
