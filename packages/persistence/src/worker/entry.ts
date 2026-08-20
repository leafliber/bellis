import { workerData } from "node:worker_threads";
import { STATE_MIGRATIONS, TELEMETRY_MIGRATIONS, prepareRegistry } from "../migrations/registry.js";
import type { MigrationDefinition } from "../migrations/definition.js";
import { DEFAULT_OUTBOX_RETRY_POLICY } from "../outbox/retry-policy.js";
import type { OutboxRetryPolicyConfig } from "../client/persistence-client.js";
import { WorkerDatabases } from "./database.js";
import { WorkerOperationRuntime } from "./operations.js";
import { startRouter } from "./rpc-router.js";

/**
 * DB Worker 入口（P2 文档 §4、§5）。
 *
 * workerData（由 createPersistenceClient 传入）：
 * - dataDirectory: string            数据目录绝对路径
 * - checkpointsEnabled?: boolean     检查点桥开关（生产装配不传）
 * - stateMigrations?/telemetryMigrations?: 测试注入注册表
 * - retryPolicy?: {baseMs,maxMs,maxAttempts,jitterSeed}
 * - wallClockMs?: number / recordIds?: string[]   测试注入审计时钟与 ID
 *
 * Worker 不做主动定时任务；生命周期由 Client 管理（close → terminate）。
 */

interface PersistenceWorkerData {
  readonly dataDirectory: string;
  readonly checkpointsEnabled?: boolean;
  readonly stateMigrations?: unknown;
  readonly telemetryMigrations?: unknown;
  readonly retryPolicy?: OutboxRetryPolicyConfig;
  readonly wallClockMs?: number;
  readonly recordIds?: readonly string[];
}

const data = workerData as PersistenceWorkerData;

function asMigrationList(
  value: unknown,
  fallback: readonly MigrationDefinition[],
): readonly MigrationDefinition[] {
  return Array.isArray(value) ? (value as readonly MigrationDefinition[]) : fallback;
}

try {
  const databases = new WorkerDatabases({
    dataDirectory: data.dataDirectory,
    wallClockMs: data.wallClockMs,
    recordIds: data.recordIds,
  });
  const retryConfig = data.retryPolicy;
  const runtime = new WorkerOperationRuntime({
    databases,
    stateMigrations: prepareRegistry(asMigrationList(data.stateMigrations, STATE_MIGRATIONS)),
    telemetryMigrations: prepareRegistry(
      asMigrationList(data.telemetryMigrations, TELEMETRY_MIGRATIONS),
    ),
    retryPolicy: retryConfig
      ? {
          baseMs: retryConfig.baseMs,
          maxMs: retryConfig.maxMs,
          maxAttempts: retryConfig.maxAttempts,
          jitterSeed: retryConfig.jitterSeed ?? DEFAULT_OUTBOX_RETRY_POLICY.jitterSeed,
        }
      : DEFAULT_OUTBOX_RETRY_POLICY,
  });
  startRouter({
    runtime,
    checkpointsEnabled: data.checkpointsEnabled === true,
  });
} catch (error) {
  console.error("[persistence-worker] failed to start:", error);
  process.exit(1);
}
