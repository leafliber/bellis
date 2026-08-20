import { randomUUID } from "node:crypto";
import type { SessionRecord, TraceContext } from "@bellis/contracts";
import { PersistenceError, toSafePersistenceError } from "../errors.js";
import type { SafePersistenceError } from "../errors.js";
import type { PersistenceCheckpointContext } from "../checkpoints/observer.js";
import { runMigrations } from "../migrations/runner.js";
import type { MigrationDefinition } from "../migrations/definition.js";
import { DEFAULT_OUTBOX_RETRY_POLICY } from "../outbox/retry-policy.js";
import type { OutboxRetryPolicy } from "../outbox/retry-policy.js";
import {
  advanceServerSeq as advanceServerSeqRow,
  ensureSessionRow,
  readLatestServerSeq,
  requireSessionRow,
} from "../repositories/sessions.js";
import {
  appendSessionRecord,
  listSessionRecords,
  nextAggregateSeq,
} from "../repositories/session-records.js";
import { insertSceneRow, lastCommittedScene, nextCommitOrdinal } from "../repositories/scenes.js";
import { advanceWatermarks, readWatermarks } from "../repositories/watermarks.js";
import {
  findIdempotencyKey,
  insertIdempotencyKey,
  sceneCommitScope,
} from "../repositories/idempotency.js";
import {
  claimOutboxRows,
  completeOutboxRow,
  insertOutboxMessages,
  readOutboxStatusCounts,
  requeueInFlightRows,
  retryOutboxRow,
} from "../repositories/outbox.js";
import type { WorkerDatabases } from "./database.js";
import type {
  OperationInputs,
  OperationResultMessage,
  PersistenceOperation,
} from "../rpc/operations.js";

/**
 * Worker 侧操作实现（P2 文档 §7-§10）。
 *
 * - 操作按到达顺序串行执行（单连接、单事务语义）。
 * - Deadline 在事务开始前检查；事务一旦开始按原子性策略完成或回滚。
 * - commitScene 步骤顺序固定，任一步失败整体回滚。
 * - SQLite 原生错误折叠为安全错误码；未分类异常细节只进 stderr。
 */

export interface OperationContext {
  readonly trace: TraceContext;
  /** 检查点桥：未启用时为 null，事务顺序与性能语义不受影响。 */
  readonly notifyCheckpoint:
    | ((
        checkpoint: "before_scene_transaction_commit",
        context: PersistenceCheckpointContext,
      ) => Promise<void>)
    | null;
  /** 请求 Deadline（epoch 微秒）；事务开始前检查。 */
  readonly deadlineUs: bigint | null;
}

export class WorkerOperationRuntime {
  readonly databases: WorkerDatabases;
  readonly stateMigrations: readonly MigrationDefinition[];
  readonly telemetryMigrations: readonly MigrationDefinition[];
  readonly retryPolicy: OutboxRetryPolicy;
  #migrated = false;
  #bootRequeueDone = false;

  constructor(options: {
    readonly databases: WorkerDatabases;
    readonly stateMigrations: readonly MigrationDefinition[];
    readonly telemetryMigrations: readonly MigrationDefinition[];
    readonly retryPolicy?: OutboxRetryPolicy;
  }) {
    this.databases = options.databases;
    this.stateMigrations = options.stateMigrations;
    this.telemetryMigrations = options.telemetryMigrations;
    this.retryPolicy = options.retryPolicy ?? DEFAULT_OUTBOX_RETRY_POLICY;
  }

  async execute(
    operation: PersistenceOperation,
    input: OperationInputs[PersistenceOperation],
    context: OperationContext,
  ): Promise<OperationResultMessage> {
    if (operation !== "ping" && operation !== "migrate" && !this.#migrated) {
      throw new PersistenceError("not_migrated", "migrate() must run before business operations");
    }
    if (
      context.deadlineUs !== null &&
      BigInt(this.databases.leaseClock.leaseNowMs()) * 1000n > context.deadlineUs
    ) {
      throw new PersistenceError("deadline_exceeded", "request deadline passed before dispatch");
    }
    switch (operation) {
      case "ping":
        return { operation, result: { pongMs: this.databases.nowMs() } };
      case "migrate": {
        const nowMs = this.databases.nowMs();
        runMigrations(this.databases.state, this.stateMigrations, nowMs);
        runMigrations(this.databases.telemetry, this.telemetryMigrations, nowMs);
        this.#migrated = true;
        const requeuedInFlight = this.#bootRequeueDone
          ? 0
          : requeueInFlightRows(this.databases.state, nowMs);
        this.#bootRequeueDone = true;
        return { operation, result: { requeuedInFlight } };
      }
      case "ensure_session":
        ensureSessionRow(this.databases.state, {
          sessionId: (input as OperationInputs["ensure_session"]).sessionId,
          createdAtMs: (input as OperationInputs["ensure_session"]).createdAtMs,
          nowMs: this.databases.nowMs(),
        });
        return { operation, result: undefined };
      case "append_record":
        return {
          operation,
          result: {
            record: appendSessionRecord(
              this.databases.state,
              (input as OperationInputs["append_record"]).record as SessionRecord,
            ),
          },
        };
      case "commit_scene":
        return this.#commitScene(input as OperationInputs["commit_scene"], context);
      case "advance_server_seq":
        return {
          operation,
          result: {
            latestServerSeq: advanceServerSeqRow(this.databases.state, {
              sessionId: (input as OperationInputs["advance_server_seq"]).sessionId,
              latestServerSeq: (input as OperationInputs["advance_server_seq"]).latestServerSeq,
              nowMs: this.databases.nowMs(),
            }),
          },
        };
      case "read_recovery_state":
        return this.#readRecoveryState((input as OperationInputs["read_recovery_state"]).sessionId);
      case "list_records":
        return {
          operation,
          result: {
            records: listSessionRecords(
              this.databases.state,
              input as OperationInputs["list_records"],
            ),
          },
        };
      case "claim_outbox":
        return {
          operation,
          result: {
            messages: claimOutboxRows(this.databases.state, {
              limit: (input as OperationInputs["claim_outbox"]).limit,
              leaseMs: (input as OperationInputs["claim_outbox"]).leaseMs,
              ownerInstanceId: (input as OperationInputs["claim_outbox"]).ownerInstanceId,
              leaseNowMs: this.databases.leaseClock.leaseNowMs(),
            }),
          },
        };
      case "complete_outbox":
        completeOutboxRow(this.databases.state, {
          outboxId: (input as OperationInputs["complete_outbox"]).outboxId,
          ownerInstanceId: (input as OperationInputs["complete_outbox"]).ownerInstanceId,
          nowMs: this.databases.nowMs(),
        });
        return { operation, result: undefined };
      case "retry_outbox":
        return {
          operation,
          result: {
            disposition: retryOutboxRow(
              this.databases.state,
              {
                outboxId: (input as OperationInputs["retry_outbox"]).outboxId,
                ownerInstanceId: (input as OperationInputs["retry_outbox"]).ownerInstanceId,
                errorCode: (input as OperationInputs["retry_outbox"]).errorCode,
                retryable: (input as OperationInputs["retry_outbox"]).retryable,
                nowMs: this.databases.nowMs(),
                leaseNowMs: this.databases.leaseClock.leaseNowMs(),
              },
              this.retryPolicy,
            ),
          },
        };
      case "read_outbox_stats":
        return {
          operation,
          result: readOutboxStatusCounts(this.databases.state),
        };
    }
  }

  async #commitScene(
    input: OperationInputs["commit_scene"],
    context: OperationContext,
  ): Promise<OperationResultMessage> {
    const state = this.databases.state;
    const nowMs = this.databases.nowMs();
    const scope = sceneCommitScope(input.sessionId);
    const scene = input.scene;
    state.exec("BEGIN IMMEDIATE");
    try {
      requireSessionRow(state, input.sessionId);

      const existing = findIdempotencyKey(state, scope, input.idempotencyKey);
      if (existing !== null) {
        if (existing.requestFingerprint !== input.requestFingerprint) {
          throw new PersistenceError(
            "idempotency_conflict",
            "idempotency key exists with a different request fingerprint",
          );
        }
        const ref = JSON.parse(existing.resultRef) as {
          sceneId: string;
          committedAtMs: number;
        };
        state.exec("ROLLBACK");
        return {
          operation: "commit_scene",
          result: {
            sceneId: ref.sceneId,
            committedAtMs: ref.committedAtMs,
            duplicate: true,
          },
        };
      }

      if (scene.sceneId !== input.sceneId || scene.cycleId !== input.cycleId) {
        throw new PersistenceError("scene_invalid", "scene payload ids do not match the request");
      }

      const commitOrdinal = nextCommitOrdinal(state, input.sessionId);
      const aggregateId = `scene-commit:${input.sessionId}`;
      const aggregateSeq = nextAggregateSeq(state, input.sessionId, aggregateId);
      appendSessionRecord(state, {
        schemaVersion: 1,
        recordId: this.databases.newRecordId(randomUUID),
        sessionId: input.sessionId,
        recordType: "scene_committed",
        aggregateId,
        aggregateSeq: aggregateSeq.toString(10),
        traceId: context.trace.traceId,
        occurredAtMs: nowMs,
        payload: {
          sceneId: input.sceneId,
          cycleId: input.cycleId,
          committedAtMs: nowMs,
          commitOrdinal,
        },
      });
      insertSceneRow(state, {
        sceneId: input.sceneId,
        cycleId: input.cycleId,
        sessionId: input.sessionId,
        commitOrdinal,
        committedAtMs: nowMs,
        schemaVersion: scene.schemaVersion,
        payloadJson: JSON.stringify(scene),
        idempotencyKey: input.idempotencyKey,
      });
      advanceWatermarks(state, input.sessionId, input.watermarks, nowMs);
      insertOutboxMessages(
        state,
        input.sessionId,
        input.outbox,
        nowMs,
        this.databases.leaseClock.leaseNowMs(),
      );
      insertIdempotencyKey(state, {
        scope,
        key: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        resultType: "commit_scene",
        resultRef: JSON.stringify({ sceneId: input.sceneId, committedAtMs: nowMs }),
        createdAtMs: nowMs,
      });

      if (context.notifyCheckpoint !== null) {
        await context.notifyCheckpoint("before_scene_transaction_commit", {
          traceId: context.trace.traceId,
          sceneId: input.sceneId,
        });
      }
      state.exec("COMMIT");
      return {
        operation: "commit_scene",
        result: { sceneId: input.sceneId, committedAtMs: nowMs, duplicate: false },
      };
    } catch (error) {
      state.exec("ROLLBACK");
      throw error;
    }
  }

  #readRecoveryState(sessionId: string): OperationResultMessage {
    const latestServerSeq = readLatestServerSeq(this.databases.state, sessionId);
    if (latestServerSeq === null) {
      throw new PersistenceError("session_not_found", `session does not exist`);
    }
    return {
      operation: "read_recovery_state",
      result: {
        sessionId,
        latestServerSeq,
        signalWatermarks: readWatermarks(this.databases.state, sessionId),
        lastCommittedScene: lastCommittedScene(this.databases.state, sessionId),
      },
    };
  }
}

/** SQLite 原生错误 → 安全错误码（细节不跨边界）。 */
export function mapSqliteError(error: unknown): SafePersistenceError {
  if (error instanceof PersistenceError) {
    return error.safe;
  }
  const text = String(error);
  if (/SQLITE_BUSY|database is locked|database is busy/i.test(text)) {
    return { code: "database_busy", message: "database is busy", retryable: true };
  }
  return toSafePersistenceError(error);
}
