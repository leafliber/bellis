import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { OutboxMessage, Scene, SessionRecord, TraceContext } from "@bellis/contracts";
import { createNoopLogger } from "@bellis/observability";
import type { LoggerPort } from "@bellis/observability";
import type {
  PersistenceCheckpoint,
  PersistenceCheckpointObserver,
} from "../checkpoints/observer.js";
import type { MigrationDefinition } from "../migrations/definition.js";
import { PersistenceError } from "../errors.js";
import type { PersistenceErrorCode, SafePersistenceError } from "../errors.js";
import { PersistenceRpcChannel } from "./rpc-channel.js";

/**
 * Persistence 公开装配接口（phase-1-build-guide.md §9.1）。
 *
 * Gate 1.1 审查结论（docs/phase-1/p2-persistence.md §3）：
 * - 新增 `ensureSession`：commitScene 依赖 Session 存在，此前无创建入口。
 * - `CommitSceneInput` 新增 `scene`：scenes.payload_json 必须写入经
 *   SceneSchema 验证的完整版本化 Payload，不再只有 ID。
 * - 新增 `advanceServerSeq`：RecoveryState.latestServerSeq 的单调推进方法。
 * - `CompleteOutboxInput`/`RetryOutboxInput` 新增 `ownerInstanceId`：
 *   Outbox 状态转换必须是条件更新，避免两个 Dispatcher 抢同一项。
 * - 新增 `listRecords`：按 Session/Trace/Aggregate 的索引查询。
 * 以上均为兼容新增，无破坏性修改，不触碰 @bellis/contracts。
 */

export interface EnsureSessionInput {
  readonly sessionId: string;
  readonly createdAtMs: number;
  readonly trace: TraceContext;
}

export interface AppendRecordInput {
  readonly record: SessionRecord;
  readonly trace: TraceContext;
}

export interface CommitSceneInput {
  readonly sceneId: string;
  readonly cycleId: string;
  readonly sessionId: string;
  /** 完整版本化 Scene Payload；Worker 验证 sceneId/cycleId 一致后写入 scenes.payload_json。 */
  readonly scene: Scene;
  readonly idempotencyKey: string;
  /** 请求摘要：同一幂等键携带不同摘要时返回冲突错误。 */
  readonly requestFingerprint: string;
  readonly watermarks: ReadonlyArray<{ source: string; watermark: bigint }>;
  readonly outbox: readonly OutboxMessage[];
  readonly trace: TraceContext;
}

export interface CommitSceneResult {
  readonly sceneId: string;
  readonly committedAtMs: number;
  readonly duplicate: boolean;
}

export interface RecoveryState {
  readonly sessionId: string;
  readonly latestServerSeq: bigint;
  readonly signalWatermarks: ReadonlyArray<{ source: string; watermark: bigint }>;
  readonly lastCommittedScene: {
    readonly sceneId: string;
    readonly cycleId: string;
    readonly committedAtMs: number;
  } | null;
}

export interface AdvanceServerSeqInput {
  readonly sessionId: string;
  readonly latestServerSeq: bigint;
  readonly trace: TraceContext;
}

export interface ListRecordsInput {
  readonly sessionId?: string;
  readonly traceId?: string;
  readonly aggregateId?: string;
  readonly limit?: number;
}

export interface ClaimOutboxInput {
  readonly limit: number;
  readonly leaseMs: number;
  readonly ownerInstanceId: string;
}

export interface CompleteOutboxInput {
  readonly outboxId: string;
  /** 条件更新：只有当前 Lease 持有者才能标记 delivered。 */
  readonly ownerInstanceId: string;
}

export interface RetryOutboxInput {
  readonly outboxId: string;
  /** 条件更新：只有当前 Lease 持有者才能触发重试或 Dead Letter。 */
  readonly ownerInstanceId: string;
  readonly errorCode: string;
  readonly retryable: boolean;
}

export interface OutboxStats {
  readonly pending: number;
  readonly inFlight: number;
  readonly delivered: number;
  readonly dead: number;
}

/** retryOutbox 的落库结果：退避重试或进入 Dead Letter。 */
export interface OutboxRetryDisposition {
  readonly disposition: "retry" | "dead";
}

export interface PersistenceClient {
  migrate(signal?: AbortSignal): Promise<void>;
  ensureSession(input: EnsureSessionInput): Promise<void>;
  appendRecord(input: AppendRecordInput): Promise<SessionRecord>;
  commitScene(input: CommitSceneInput): Promise<CommitSceneResult>;
  advanceServerSeq(input: AdvanceServerSeqInput): Promise<bigint>;
  readRecoveryState(sessionId: string): Promise<RecoveryState>;
  listRecords(input: ListRecordsInput): Promise<SessionRecord[]>;
  claimOutbox(input: ClaimOutboxInput): Promise<OutboxMessage[]>;
  completeOutbox(input: CompleteOutboxInput): Promise<void>;
  retryOutbox(input: RetryOutboxInput): Promise<OutboxRetryDisposition>;
  readOutboxStats(): Promise<OutboxStats>;
  close(): Promise<void>;
}

/** Worker 入口注入：默认指向包产物；测试指向 TS 源码并注入解析 hook。 */
export interface PersistenceWorkerOptions {
  readonly url?: URL | string;
  readonly execArgv?: readonly string[];
}

/** Outbox 重试策略（Worker 内执行退避；抖动由种子确定性导出）。 */
export interface OutboxRetryPolicyConfig {
  /** 首次重试基准延迟（毫秒）。 */
  readonly baseMs: number;
  /** 退避上限（毫秒）。 */
  readonly maxMs: number;
  /** 超过该尝试次数进入 dead。 */
  readonly maxAttempts: number;
  /** 抖动种子；相同种子 + 尝试次数得到相同抖动（可重放测试）。 */
  readonly jitterSeed?: number;
}

export interface PersistenceMigrationsOverride {
  readonly state?: readonly MigrationDefinition[];
  readonly telemetry?: readonly MigrationDefinition[];
}

export interface PersistenceClientOptions {
  /** 数据目录绝对路径；由调用方显式传入，没有仓库内默认值。 */
  readonly dataDirectory: string;
  /** 单请求默认 Deadline（毫秒），默认 10_000。 */
  readonly defaultDeadlineMs?: number;
  readonly worker?: PersistenceWorkerOptions;
  /** 受控检查点观察器；生产留空（No-op）。 */
  readonly checkpointObserver?: PersistenceCheckpointObserver;
  /** Outbox 重试策略；缺省 baseMs=100、maxMs=30_000、maxAttempts=8。 */
  readonly retryPolicy?: OutboxRetryPolicyConfig;
  /** 预置 recordId 序列（测试注入，按序消耗，耗尽后回退 randomUUID）。 */
  readonly recordIds?: readonly string[];
  /** 固定审计墙钟（epoch ms，测试注入；不参与恢复排序与 Lease 判断）。 */
  readonly wallClockMs?: number;
  readonly logger?: LoggerPort;
}

/**
 * @internal 仅供包内测试装配：注入 Migration 注册表（含任意 SQL 文本）。
 * 不从包根导出（package.json exports 只暴露 "."），外部消费者无法触达，
 * 公开 PersistenceClientOptions 不存在任何 SQL 通道（评审项 5）。
 */
export interface InternalPersistenceTestOverrides {
  readonly migrations?: PersistenceMigrationsOverride;
}

/** RPC 通道诊断事件（测试用；不进入生产日志必选字段）。 */
export interface PersistenceRpcDiagnostic {
  readonly kind: "late_response_dropped" | "unknown_response_dropped";
  readonly requestId: string;
  readonly code: PersistenceErrorCode;
  readonly safe: SafePersistenceError;
}

const DEFAULT_DEADLINE_MS = 10_000;

function internalTrace(): TraceContext {
  return { traceId: randomUUID().replaceAll("-", "") };
}

function resolveWorkerUrl(url: URL | string): URL {
  if (url instanceof URL) {
    return url;
  }
  if (url.startsWith("file:")) {
    return new URL(url);
  }
  if (!isAbsolute(url)) {
    throw new PersistenceError("invalid_request", "worker url must be absolute or a file URL");
  }
  return pathToFileURL(url);
}

/** 公开装配工厂：创建绑定 DB Worker 的 PersistenceClient。 */
export function createPersistenceClient(options: PersistenceClientOptions): PersistenceClient {
  // overrides 恒为空对象：实现只从第二个参数读取 migrations，
  // 调用方即使通过 JS 附加属性或 TS 强转向 options 塞入 migrations
  // 也会被忽略——公开入口不存在任何 SQL 通道（评审残留 1）。
  return createPersistenceClientForTesting(options, {});
}

/** @internal 测试装配入口：额外允许注入 Migration 注册表（不从包根导出）。 */
export function createPersistenceClientForTesting(
  options: PersistenceClientOptions,
  overrides: InternalPersistenceTestOverrides = {},
): PersistenceClient {
  if (!isAbsolute(options.dataDirectory)) {
    throw new PersistenceError(
      "invalid_request",
      "dataDirectory must be an absolute path; there is no repository-local default",
    );
  }
  const logger = options.logger ?? createNoopLogger();
  const defaultDeadlineMs = options.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS;
  const workerUrl = resolveWorkerUrl(
    options.worker?.url ?? new URL("../worker/entry.js", import.meta.url),
  );
  const observer = options.checkpointObserver;
  const channel = new PersistenceRpcChannel({
    workerUrl,
    execArgv: options.worker?.execArgv,
    workerData: {
      dataDirectory: options.dataDirectory,
      checkpointsEnabled: observer !== undefined,
      // migrations 只来自 overrides（包内测试装配第二参数）；
      // options 上的任何未知属性都不会进入 workerData。
      stateMigrations: overrides.migrations?.state,
      telemetryMigrations: overrides.migrations?.telemetry,
      retryPolicy: options.retryPolicy,
      wallClockMs: options.wallClockMs,
      recordIds: options.recordIds,
    },
    defaultDeadlineMs,
    logger,
    onCheckpointNotice: observer
      ? (notice) =>
          observer.reached(
            notice.checkpoint as PersistenceCheckpoint,
            {
              traceId: notice.context.traceId,
              ...(notice.context.sceneId === undefined ? {} : { sceneId: notice.context.sceneId }),
              ...(notice.context.outboxId === undefined
                ? {}
                : { outboxId: notice.context.outboxId }),
            },
            notice.signal,
          )
      : undefined,
  });
  let migrated = false;

  const requireMigrated = (): void => {
    if (!migrated) {
      throw new PersistenceError("not_migrated", "migrate() must run before business operations");
    }
  };

  return {
    async migrate(signal?: AbortSignal): Promise<void> {
      await channel.call<"migrate">({ operation: "migrate", input: undefined }, internalTrace(), {
        signal,
      });
      migrated = true;
    },
    async ensureSession(input: EnsureSessionInput): Promise<void> {
      requireMigrated();
      await channel.call<"ensure_session">(
        {
          operation: "ensure_session",
          input: { sessionId: input.sessionId, createdAtMs: input.createdAtMs },
        },
        input.trace,
      );
    },
    async appendRecord(input: AppendRecordInput): Promise<SessionRecord> {
      requireMigrated();
      const result = await channel.call<"append_record">(
        { operation: "append_record", input: { record: input.record } },
        input.trace,
      );
      return result.record as SessionRecord;
    },
    async commitScene(input: CommitSceneInput): Promise<CommitSceneResult> {
      requireMigrated();
      const { trace: _trace, ...payload } = input;
      const result = await channel.call<"commit_scene">(
        { operation: "commit_scene", input: payload },
        input.trace,
      );
      return result;
    },
    async advanceServerSeq(input: AdvanceServerSeqInput): Promise<bigint> {
      requireMigrated();
      const result = await channel.call<"advance_server_seq">(
        {
          operation: "advance_server_seq",
          input: { sessionId: input.sessionId, latestServerSeq: input.latestServerSeq },
        },
        input.trace,
      );
      return result.latestServerSeq;
    },
    async readRecoveryState(sessionId: string): Promise<RecoveryState> {
      requireMigrated();
      const result = await channel.call<"read_recovery_state">(
        { operation: "read_recovery_state", input: { sessionId } },
        internalTrace(),
      );
      return result;
    },
    async listRecords(input: ListRecordsInput): Promise<SessionRecord[]> {
      requireMigrated();
      const result = await channel.call<"list_records">(
        {
          operation: "list_records",
          input: {
            ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
            ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
            ...(input.aggregateId === undefined ? {} : { aggregateId: input.aggregateId }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          },
        },
        internalTrace(),
      );
      return result.records as SessionRecord[];
    },
    async claimOutbox(input: ClaimOutboxInput): Promise<OutboxMessage[]> {
      requireMigrated();
      const result = await channel.call<"claim_outbox">(
        {
          operation: "claim_outbox",
          input: {
            limit: input.limit,
            leaseMs: input.leaseMs,
            ownerInstanceId: input.ownerInstanceId,
          },
        },
        internalTrace(),
      );
      return result.messages as OutboxMessage[];
    },
    async completeOutbox(input: CompleteOutboxInput): Promise<void> {
      requireMigrated();
      await channel.call<"complete_outbox">(
        {
          operation: "complete_outbox",
          input: {
            outboxId: input.outboxId,
            ownerInstanceId: input.ownerInstanceId,
          },
        },
        internalTrace(),
      );
    },
    async retryOutbox(input: RetryOutboxInput): Promise<OutboxRetryDisposition> {
      requireMigrated();
      const result = await channel.call<"retry_outbox">(
        {
          operation: "retry_outbox",
          input: {
            outboxId: input.outboxId,
            ownerInstanceId: input.ownerInstanceId,
            errorCode: input.errorCode,
            retryable: input.retryable,
          },
        },
        internalTrace(),
      );
      return result;
    },
    async readOutboxStats(): Promise<OutboxStats> {
      requireMigrated();
      const result = await channel.call<"read_outbox_stats">(
        { operation: "read_outbox_stats", input: undefined },
        internalTrace(),
      );
      return result;
    },
    async close(): Promise<void> {
      await channel.close(defaultDeadlineMs);
    },
  };
}
