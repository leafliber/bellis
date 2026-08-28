import { createHash, randomUUID } from "node:crypto";
import type {
  IngestedSignal,
  JsonValue,
  SessionRecord,
  Signal,
  SignalPriorityClass,
} from "@bellis/contracts";
import {
  Phase3BatchSealedPayloadSchema,
  Phase3CycleFinishedPayloadSchema,
  Phase3ModelRequestPayloadSchema,
  Phase3SignalIngestedPayloadSchema,
  Phase3ToolRunPayloadSchema,
  Phase3TurnFinishedPayloadSchema,
  Phase3TurnStartedPayloadSchema,
  TraceIdSchema,
} from "@bellis/contracts";
import type { PersistenceClient, Phase3DecisionState } from "@bellis/persistence";
import type {
  CycleAdoptionInput,
  CycleAdoptionPort,
  DecisionAuditPort,
  SignalAppendOutcome,
  SignalRestoreState,
  SignalStorePort,
} from "@bellis/decision-loop";
import type { ToolCacheStore } from "@bellis/tool-runtime";
import type { LoggerPort } from "@bellis/observability";

/**
 * Phase 3 持久化适配器（phase-3-development-guide.md §9.3）：
 * 把 @bellis/decision-loop 的 Port 适配到 PersistenceClient。
 * 审计失败不阻塞决策路径，但显式记录（不吞错）。
 */

export interface Phase3AdapterOptions {
  readonly persistence: PersistenceClient;
  readonly logger?: LoggerPort;
  readonly normalCapacity: number;
  readonly urgentCapacity: number;
}

/** Signal 持久化：真实 DB Worker 事务内分配序号。 */
export class DurableSignalStore implements SignalStorePort {
  readonly #options: Phase3AdapterOptions;
  #sessionId: string;

  constructor(options: Phase3AdapterOptions, sessionId: string) {
    this.#options = options;
    this.#sessionId = sessionId;
  }

  bindSessionId(sessionId: string): void {
    this.#sessionId = sessionId;
  }

  async append(signal: Signal, priorityClass: SignalPriorityClass): Promise<SignalAppendOutcome> {
    return this.#options.persistence.phase3AppendSignal({
      sessionId: this.#sessionId,
      signal,
      priorityClass,
      receivedAtMs: Date.now(),
      normalCapacity: this.#options.normalCapacity,
      urgentCapacity: this.#options.urgentCapacity,
      trace: { traceId: newTraceId() },
    });
  }

  async restore(): Promise<SignalRestoreState> {
    return this.#options.persistence.phase3RestoreSignals(this.#sessionId);
  }

  markConsumed(_sequence: bigint): void {
    // 持久化消费水位由 adoptCycle 原子事务推进（ADR 0004 §4）；
    // Loop 的 onWatermarkConsumed 回调在此只承担内存管道同步
    //（SignalPipeline 已持有 InMemory 视图），不引入第二次写。
  }

  /** 恢复投影：非幂等 running → uncertain（绝不自动重试）。 */
  async readDecisionState(): Promise<Phase3DecisionState> {
    return this.#options.persistence.phase3ReadDecisionState(this.#sessionId, {
      markUncertain: true,
    });
  }
}

function newTraceId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 32);
}

/** Cycle adoption：真实事务（cycle 行 + 水位 + Tool Run planned + Record）。 */
export class DurableCycleAdoption implements CycleAdoptionPort {
  readonly #options: Phase3AdapterOptions;
  #sessionId: string;

  constructor(options: Phase3AdapterOptions, sessionId: string) {
    this.#options = options;
    this.#sessionId = sessionId;
  }

  bindSessionId(sessionId: string): void {
    this.#sessionId = sessionId;
  }

  async adoptCycle(input: CycleAdoptionInput): Promise<void> {
    await this.#options.persistence.phase3AdoptCycle({
      sessionId: this.#sessionId,
      turnId: input.turnId,
      cycleId: input.cycleId,
      cycleIndex: input.cycleIndex,
      batchId: input.batchId,
      watermarkFrom: input.watermarkFrom,
      watermarkTo: input.watermarkTo,
      next: input.packet.next,
      degraded: input.degraded,
      packetDigest: input.packetDigest,
      toolRuns: input.packet.toolCalls.map((call) => ({
        toolRunId: call.toolRunId,
        toolName: call.toolName,
        idempotencyKeyHash: call.idempotencyKey === undefined ? null : hashKey(call.idempotencyKey),
      })),
      trace: { traceId: normalizeTrace(input.traceId) },
    });
  }
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function normalizeTrace(traceId: string): string {
  return TraceIdSchema.safeParse(traceId).success ? traceId : newTraceId();
}

/** 版本化审计 Record 追加（Loop/Ingress/ToolRun 事件）。 */
export class Phase3AuditRecorder implements DecisionAuditPort {
  readonly #persistence: PersistenceClient;
  readonly #logger: LoggerPort | undefined;
  #sessionId: string;

  constructor(
    options: { persistence: PersistenceClient; logger?: LoggerPort | undefined },
    sessionId: string,
  ) {
    this.#persistence = options.persistence;
    this.#logger = options.logger ?? undefined;
    this.#sessionId = sessionId;
  }

  bindSessionId(sessionId: string): void {
    this.#sessionId = sessionId;
  }

  turnStarted(payload: {
    turnId: string;
    trigger: "normal_batch" | "interrupt" | "next_turn";
    batchId: string;
  }): void {
    this.#append(
      "phase3_turn_started",
      `turn:${payload.turnId}`,
      Phase3TurnStartedPayloadSchema,
      {
        payloadVersion: 1,
        turnId: payload.turnId,
        trigger: payload.trigger,
        batchId: payload.batchId,
      },
      payload.turnId,
    );
  }

  turnFinished(payload: {
    turnId: string;
    result: "completed" | "cancelled" | "failed" | "degraded";
    cycleCount: number;
    reason?: string;
  }): void {
    this.#append(
      "phase3_turn_finished",
      `turn:${payload.turnId}`,
      Phase3TurnFinishedPayloadSchema,
      {
        payloadVersion: 1,
        turnId: payload.turnId,
        result: payload.result,
        cycleCount: payload.cycleCount,
        ...(payload.reason === undefined ? {} : { reason: payload.reason }),
      },
      payload.turnId,
    );
  }

  modelRequest(payload: {
    cycleId: string;
    provider: string;
    outcome: "final" | "degraded" | "failed" | "aborted";
    degradationReason?:
      | "timeout"
      | "stream_broken"
      | "invalid_packet"
      | "content_policy"
      | "aborted";
    ttftMs?: number;
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  }): void {
    this.#append(
      "phase3_model_request",
      `cycle:${payload.cycleId}`,
      Phase3ModelRequestPayloadSchema,
      {
        payloadVersion: 1,
        cycleId: payload.cycleId,
        provider: payload.provider,
        outcome: payload.outcome,
        ...(payload.degradationReason === undefined
          ? {}
          : { degradationReason: payload.degradationReason }),
        ...(payload.ttftMs === undefined ? {} : { ttftMs: payload.ttftMs }),
        ...(payload.durationMs === undefined ? {} : { durationMs: payload.durationMs }),
        ...(payload.inputTokens === undefined ? {} : { inputTokens: payload.inputTokens }),
        ...(payload.outputTokens === undefined ? {} : { outputTokens: payload.outputTokens }),
        ...(payload.cachedInputTokens === undefined
          ? {}
          : { cachedInputTokens: payload.cachedInputTokens }),
      },
      payload.cycleId,
    );
  }

  cycleFinished(payload: {
    turnId: string;
    cycleId: string;
    result: "completed" | "cancelled" | "failed";
    next: "finish" | "after_tools" | "continue";
    sceneSubmitted: boolean;
  }): void {
    this.#append(
      "phase3_cycle_finished",
      `cycle:${payload.cycleId}`,
      Phase3CycleFinishedPayloadSchema,
      {
        payloadVersion: 1,
        turnId: payload.turnId,
        cycleId: payload.cycleId,
        result: payload.result,
        next: payload.next,
        sceneSubmitted: payload.sceneSubmitted,
      },
      payload.cycleId,
    );
  }

  signalIngested(payload: {
    signalId: string;
    result: "accepted" | "deduplicated" | "rejected";
    sequence?: bigint;
    priorityClass?: SignalPriorityClass;
    reason?: string;
  }): void {
    this.#append(
      "phase3_signal_ingested",
      `signal:${payload.signalId}`,
      Phase3SignalIngestedPayloadSchema,
      {
        payloadVersion: 1,
        signalId: payload.signalId,
        ...(payload.sequence === undefined ? {} : { sequence: payload.sequence.toString(10) }),
        result: payload.result,
        ...(payload.priorityClass === undefined ? {} : { priorityClass: payload.priorityClass }),
        ...(payload.reason === undefined ? {} : { reason: payload.reason }),
      },
      payload.signalId,
    );
  }

  batchSealed(payload: {
    batchId: string;
    watermarkFrom: bigint;
    watermarkTo: bigint;
    trigger: string;
    messageCount: number;
    urgentCount: number;
    tokenEstimate: number;
  }): void {
    this.#append(
      "phase3_batch_sealed",
      `batch:${payload.batchId}`,
      Phase3BatchSealedPayloadSchema,
      {
        payloadVersion: 1,
        batchId: payload.batchId,
        watermarkFrom: payload.watermarkFrom.toString(10),
        watermarkTo: payload.watermarkTo.toString(10),
        trigger: payload.trigger as
          | "deadline"
          | "count"
          | "token_budget"
          | "byte_budget"
          | "urgent_bypass"
          | "close",
        messageCount: payload.messageCount,
        urgentCount: payload.urgentCount,
        tokenEstimate: payload.tokenEstimate,
      },
      payload.batchId,
    );
  }

  toolRun(payload: {
    toolRunId: string;
    cycleId: string;
    toolName: string;
    transition: "planned" | "started" | "finished";
    state?: string;
    durationMs?: number;
    errorCode?: string;
    idempotencyKeyHash?: string;
  }): void {
    this.#append(
      "phase3_tool_run",
      `toolrun:${payload.toolRunId}`,
      Phase3ToolRunPayloadSchema,
      {
        payloadVersion: 1,
        toolRunId: payload.toolRunId,
        cycleId: payload.cycleId,
        toolName: payload.toolName,
        transition: payload.transition,
        ...(payload.state === undefined
          ? {}
          : {
              state: payload.state as
                | "planned"
                | "running"
                | "succeeded"
                | "failed"
                | "timeout"
                | "cancelled"
                | "denied"
                | "dependency_failed"
                | "uncertain",
            }),
        ...(payload.durationMs === undefined ? {} : { durationMs: payload.durationMs }),
        ...(payload.errorCode === undefined ? {} : { errorCode: payload.errorCode }),
        ...(payload.idempotencyKeyHash === undefined
          ? {}
          : { idempotencyKeyHash: payload.idempotencyKeyHash }),
      },
      payload.toolRunId,
    );
    // 状态投影（phase3_tool_runs 行）与 Record 同步维护。
    if (payload.transition !== "planned") {
      void this.#persistence
        .phase3ToolRunEvent({
          sessionId: this.#sessionId,
          toolRunId: payload.toolRunId,
          cycleId: payload.cycleId,
          toolName: payload.toolName,
          transition: payload.transition,
          state: payload.state ?? (payload.transition === "started" ? "running" : "succeeded"),
          ...(payload.durationMs === undefined ? {} : { durationMs: payload.durationMs }),
          ...(payload.errorCode === undefined ? {} : { errorCode: payload.errorCode }),
          trace: { traceId: normalizeTrace(payload.toolRunId) },
        })
        .catch(() => undefined);
    }
  }

  #append(
    recordType: string,
    aggregateId: string,
    schema: { safeParse(value: unknown): { success: boolean } },
    payload: unknown,
    seed: string,
  ): void {
    if (!schema.safeParse(payload).success) {
      this.#logger?.log("warn", "phase3_audit_payload_invalid", { recordType });
      return;
    }
    const record: SessionRecord = {
      schemaVersion: 1,
      recordId: randomUUID(),
      sessionId: this.#sessionId,
      recordType,
      aggregateId,
      // Trace 根：合法 32 位小写十六进制（TraceIdSchema 同源校验）。
      traceId: createHash("sha256").update(seed).digest("hex").slice(0, 32),
      occurredAtMs: Date.now(),
      payload: payload as JsonValue,
    };
    void this.#persistence
      .appendRecord({ record, trace: { traceId: record.traceId } })
      .catch((error: unknown) => {
        this.#logger?.log("warn", "phase3_audit_append_failed", {
          recordType,
          error: error instanceof Error ? error.message : "unknown",
        });
      });
  }
}

/** L2 Tool 缓存（SQLite TTL）。 */
export class DurableToolCacheStore implements ToolCacheStore {
  readonly #persistence: PersistenceClient;

  constructor(persistence: PersistenceClient) {
    this.#persistence = persistence;
  }

  async get(key: string): Promise<{ value: JsonValue } | undefined> {
    const payload = await this.#persistence.phase3ToolCacheGet(key);
    if (payload === null || payload === undefined) {
      return undefined;
    }
    return { value: payload as JsonValue };
  }

  async set(key: string, value: JsonValue, ttlMs: number): Promise<void> {
    await this.#persistence.phase3ToolCacheSet({
      cacheKey: key,
      toolName: "cached",
      payload: value,
      ttlMs,
    });
  }
}

export type { IngestedSignal };
