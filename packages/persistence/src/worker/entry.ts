import { workerData } from "node:worker_threads";
import { STATE_MIGRATIONS, TELEMETRY_MIGRATIONS, prepareRegistry } from "../migrations/registry.js";
import type { MigrationDefinition } from "../migrations/definition.js";
import { PersistenceError } from "../errors.js";
import { DEFAULT_OUTBOX_RETRY_POLICY } from "../outbox/retry-policy.js";
import type { OutboxRetryPolicyConfigWire } from "./entry-options.js";
import { WorkerDatabases } from "./database.js";
import { WorkerOperationRuntime } from "./operations.js";
import { startRouter } from "./rpc-router.js";

/**
 * DB Worker 入口（docs/protocols/persistence-and-recovery.md）。
 *
 * workerData（由 createPersistenceClient 传入）：
 * - dataDirectory: string            数据目录绝对路径
 * - checkpointsEnabled?: boolean     检查点桥开关（生产装配不传）
 * - stateMigrations?/telemetryMigrations?: 包内测试装配注入（非公开 API）
 * - retryPolicy?: {baseMs,maxMs,maxAttempts,jitterSeed}
 * - wallClockMs?: number / recordIds?: string[]   测试注入审计时钟与 ID
 *
 * Worker 不做主动定时任务；生命周期由 Client 管理（close → terminate）。
 * 启动失败的 stderr 只输出脱敏的安全码与稳定消息——不含数据库绝对
 * 路径、堆栈或原始异常文本（评审项 6）。
 */

interface PersistenceWorkerData {
  readonly dataDirectory: string;
  readonly checkpointsEnabled?: boolean;
  readonly diskAdmission?: import("../disk-admission.js").PersistenceDiskAdmissionOptions;
  readonly stateMigrations?: unknown;
  readonly telemetryMigrations?: unknown;
  readonly retryPolicy?: OutboxRetryPolicyConfigWire;
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

function safeStartupError(error: unknown): { code: string; message: string } {
  if (error instanceof PersistenceError) {
    return { code: error.code, message: error.message };
  }
  if (/BUSY|locked/i.test(String(error))) {
    return {
      code: "unavailable",
      message: "another persistence worker already owns this data directory",
    };
  }
  return { code: "internal", message: "persistence worker failed to start" };
}

try {
  const databases = new WorkerDatabases({
    dataDirectory: data.dataDirectory,
    diskAdmission: data.diskAdmission,
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
  const safe = safeStartupError(error);
  console.error(
    JSON.stringify({
      event: "persistence_worker_start_failed",
      code: safe.code,
      message: safe.message,
    }),
  );
  process.exit(1);
}
