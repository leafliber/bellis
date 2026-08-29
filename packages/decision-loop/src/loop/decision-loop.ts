import type {
  AudienceBatch,
  CycleSnapshot,
  DecisionPacket,
  MonotonicClock,
  RecentUtterance,
  ToolResult,
} from "@bellis/contracts";
import { buildToolModelSpec, type ToolRuntime } from "@bellis/tool-runtime";
import type { LoopLogger, LoopMetrics } from "../observability.js";
import type { ModelProvider, ModelRequest } from "../model/provider.js";
import { StreamAssembler } from "../model/stream-assembler.js";
import { mergeBatches, type TurnOwnerPort } from "../trigger/decision-trigger.js";
import type { CycleAdoptionPort, PerformancePort } from "./ports.js";
import type { DecisionAuditPort } from "./audit.js";
import {
  buildSafetyPacket,
  type DegradationPolicy,
  type DegradationReason,
} from "./degradation.js";
import { buildModelRequest, packetDigest } from "./request-assembly.js";

/**
 * Decision Loop：唯一拥有提交权的 Turn/Cycle 状态机
 * （phase-3-development-guide.md §7.3，不变量 1/2/5/6/8/11）。
 *
 * ```text
 * Turn: queued → running → finishing → completed
 *                     ├─→ cancelling → cancelled
 *                     └─→ failed/degraded
 * Cycle: snapshot → requesting → validating → adopting
 *        → dispatching(action ∥ tools) → awaiting_next → completed
 * ```
 *
 * - 一请求恰好一个最终 DecisionPacket（合法或安全包），恰好一个
 *   ActionFrame；发言只来自 action.speech；
 * - adoption 成功前不提交 Scene、不执行 Tool；成功后 Scene 与 Tool
 *   并行（不等待提示语播放完成才调 Tool）；
 * - 工具结果只进后续 Cycle；取消沿 Turn → Cycle → Model/Tool/Scene
 *   父子域传播（Abort + Deadline，失败分支真正 Abort）；
 * - Provider/Tool/Context 只是能力供应者，不推进 Loop。
 */
export interface DecisionLoopConfig {
  readonly maxCyclesPerTurn: number;
  readonly maxParallelTools: number;
  readonly modelTimeoutMs: number;
  readonly turnDeadlineMs: number;
  /** 连续「无新输入、无工具结果」的 continue 空转上限 → 安全帧结束。 */
  readonly idleSpinLimit: number;
}

export const DEFAULT_DECISION_LOOP_CONFIG: DecisionLoopConfig = {
  maxCyclesPerTurn: 8,
  maxParallelTools: 8,
  modelTimeoutMs: 20_000,
  turnDeadlineMs: 120_000,
  idleSpinLimit: 2,
};

export interface DecisionLoopOptions {
  readonly sessionId: string;
  readonly provider: ModelProvider;
  readonly tools: ToolRuntime;
  readonly adoption: CycleAdoptionPort;
  readonly performance: PerformancePort;
  readonly clock: MonotonicClock;
  readonly ids: {
    readonly turnId: () => string;
    readonly cycleId: () => string;
    readonly requestId: () => string;
    readonly batchId: () => string;
    readonly traceId: () => string;
  };
  readonly instructions: string;
  readonly model: string;
  readonly config?: Partial<DecisionLoopConfig>;
  readonly degradationPolicy?: DegradationPolicy;
  /** Session/Profile Capability 集合（Tool 权限检查用）。 */
  readonly capabilities?: ReadonlySet<string>;
  readonly logger?: LoopLogger;
  readonly metrics?: LoopMetrics;
  readonly audit?: DecisionAuditPort;
  /** Cycle adoption 成功后推进消费水位（宿主接 SignalPipeline）。 */
  readonly onWatermarkConsumed?: (watermarkTo: bigint) => void;
  /** Turn 终态回调（宿主接 Trigger.notifyOwnerIdle）。 */
  readonly onTurnSettled?: (turnId: string, result: TurnResult) => void;
  /** Turn 结束时仍未采用的 Batch 回插（宿主接 Trigger.requeueFront）。 */
  readonly onUnadoptedReturn?: (batches: readonly AudienceBatch[]) => void;
}

export type TurnResult = "completed" | "cancelled" | "failed" | "degraded";

interface TurnState {
  readonly turnId: string;
  readonly trigger: "normal_batch" | "interrupt" | "next_turn";
  readonly abort: AbortController;
  readonly startedUs: bigint;
  status: "running" | "finishing";
  /** 本 Cycle 尚未采用的 Batch；adoption 后清空。 */
  snapshotBatch: AudienceBatch | null;
  /** mergeIntoNextCycle 缓冲（区间升序，未采用）。 */
  merged: AudienceBatch[];
  pendingToolResults: ToolResult[];
  recentSpeech: RecentUtterance[];
  idleSpins: number;
  adoptedCount: number;
  degraded: boolean;
  lastConsumedTo: bigint;
  result: TurnResult | null;
  finishReason?: string;
}

type CycleOutcome =
  | { readonly kind: "advance"; readonly next: "finish" | "after_tools" | "continue" }
  | { readonly kind: "cancel" }
  | { readonly kind: "fail" };

export class DecisionLoop implements TurnOwnerPort {
  readonly #options: DecisionLoopOptions;
  readonly #config: DecisionLoopConfig;
  #turn: TurnState | null = null;
  #chain: Promise<unknown> = Promise.resolve();
  #closed = false;
  readonly #backgroundTasks = new Set<Promise<unknown>>();

  constructor(options: DecisionLoopOptions) {
    this.#options = options;
    this.#config = { ...DEFAULT_DECISION_LOOP_CONFIG, ...options.config };
  }

  get activeTurnId(): string | null {
    return this.#turn?.turnId ?? null;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  /** 进行中的后台任务数（Scene/后台 Tool；close 时等待）。 */
  get backgroundTaskCount(): number {
    return this.#backgroundTasks.size;
  }

  isIdle(): boolean {
    return this.#turn === null;
  }

  cancelActiveTurn(): readonly AudienceBatch[] {
    const turn = this.#turn;
    if (turn === null) {
      return [];
    }
    const unadopted: AudienceBatch[] = [];
    if (turn.snapshotBatch !== null) {
      unadopted.push(turn.snapshotBatch);
    }
    unadopted.push(...turn.merged);
    turn.merged = [];
    turn.snapshotBatch = null;
    turn.abort.abort(new Error("turn_interrupted"));
    return unadopted;
  }

  startTurn(batch: AudienceBatch, trigger: "normal_batch" | "interrupt" | "next_turn"): boolean {
    if (this.#closed) {
      return false;
    }
    if (this.#turn !== null) {
      if (trigger !== "interrupt") {
        return false;
      }
      this.cancelActiveTurn();
    }
    const turn: TurnState = {
      turnId: this.#options.ids.turnId(),
      trigger,
      abort: new AbortController(),
      startedUs: this.#options.clock.nowUs(),
      status: "running",
      snapshotBatch: batch,
      merged: [],
      pendingToolResults: [],
      recentSpeech: [],
      idleSpins: 0,
      adoptedCount: 0,
      degraded: false,
      lastConsumedTo: BigInt(batch.watermarkFrom) - 1n,
      result: null,
    };
    // Turn 转换串行：前一个 runTurn 完成后才启动新 Turn。
    this.#chain = this.#chain
      .then(() => this.#runTurn(turn))
      .catch((error: unknown) => {
        this.#options.logger?.log("error", "decision_turn_crashed", {
          turnId: turn.turnId,
          error: error instanceof Error ? error.message : "unknown",
        });
        this.#turn = null;
        turn.result ??= "failed";
        this.#options.onTurnSettled?.(turn.turnId, turn.result);
      });
    return true;
  }

  mergeIntoNextCycle(batch: AudienceBatch): boolean {
    const turn = this.#turn;
    if (turn === null || turn.status !== "running") {
      return false;
    }
    turn.merged.push(batch);
    return true;
  }

  /** Session 关闭：取消活跃 Turn、等待全部子任务与后台 Tool 释放。 */
  async close(reason: string): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.cancelActiveTurn();
    await this.#chain;
    const background = [...this.#backgroundTasks];
    this.#backgroundTasks.clear();
    await Promise.allSettled(background);
    void reason;
  }

  async #runTurn(turn: TurnState): Promise<void> {
    this.#turn = turn;
    this.#options.audit?.turnStarted({
      turnId: turn.turnId,
      trigger: turn.trigger,
      batchId: turn.snapshotBatch?.id ?? "",
    });
    while (turn.status === "running" && !turn.abort.signal.aborted) {
      if (turn.adoptedCount >= this.#config.maxCyclesPerTurn) {
        await this.#finishWithSafety(turn, "timeout", "cycle_budget");
        break;
      }
      if (
        this.#options.clock.nowUs() - turn.startedUs >=
        BigInt(this.#config.turnDeadlineMs) * 1_000n
      ) {
        await this.#finishWithSafety(turn, "timeout", "turn_deadline");
        break;
      }
      const outcome = await this.#runCycle(turn);
      if (outcome.kind === "fail") {
        turn.result = "failed";
        turn.finishReason = "adoption_failed";
        break;
      }
      if (outcome.kind === "cancel") {
        break;
      }
      if (outcome.next === "finish") {
        turn.status = "finishing";
        break;
      }
    }
    if (turn.abort.signal.aborted) {
      turn.result ??= "cancelled";
      // 可中断 Scene 经 PerformancePort → Director 取消（不绕过 Director）。
      try {
        await this.#options.performance.interruptActiveScenes(`turn_cancelled`);
      } catch (error) {
        this.#options.logger?.log("warn", "scene_interrupt_failed", {
          turnId: turn.turnId,
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    }
    turn.result ??= turn.degraded ? "degraded" : "completed";
    this.#turn = null;
    const unadopted: AudienceBatch[] = [...turn.merged];
    if (turn.snapshotBatch !== null) {
      unadopted.unshift(turn.snapshotBatch);
    }
    turn.merged = [];
    turn.snapshotBatch = null;
    this.#options.metrics?.counter("bellis_decision_turns_total", { result: turn.result }).inc();
    this.#options.audit?.turnFinished({
      turnId: turn.turnId,
      result: turn.result,
      cycleCount: turn.adoptedCount,
      ...(turn.finishReason === undefined ? {} : { reason: turn.finishReason }),
    });
    // failed = 基础设施故障：不回插（避免失败-重试死循环）；输入仍在
    // 持久化存储中，由宿主运维显式对账。cancelled/提前结束的未采用
    // 输入回插队首（区间连续性保持）。
    if (unadopted.length > 0 && turn.result !== "failed") {
      this.#options.onUnadoptedReturn?.(unadopted);
    }
    this.#options.onTurnSettled?.(turn.turnId, turn.result);
  }

  /** 预算/Deadline 耗尽：采用确定性安全帧（覆盖未采用 merged）后结束。 */
  async #finishWithSafety(
    turn: TurnState,
    reason: DegradationReason,
    label: string,
  ): Promise<void> {
    const cycleId = this.#options.ids.cycleId();
    const packet = buildSafetyPacket(cycleId, reason, this.#options.degradationPolicy);
    // 未采用的 merged 并入安全帧区间（不吞输入；无 merged 时退化为
    // lastConsumedTo 的幂等空区间）。
    let batchId = this.#options.ids.batchId();
    let watermarkFrom = turn.lastConsumedTo;
    let watermarkTo = turn.lastConsumedTo;
    if (turn.merged.length > 0) {
      let union = turn.merged[0]!;
      for (let index = 1; index < turn.merged.length; index += 1) {
        union = mergeBatches(union, turn.merged[index]!);
      }
      batchId = union.id;
      watermarkFrom = BigInt(union.watermarkFrom);
      watermarkTo = BigInt(union.watermarkTo);
      turn.merged = [];
    }
    try {
      await this.#options.adoption.adoptCycle({
        turnId: turn.turnId,
        cycleId,
        cycleIndex: turn.adoptedCount,
        packet,
        packetDigest: packetDigest(packet),
        batchId,
        watermarkFrom,
        watermarkTo,
        degraded: true,
        traceId: this.#options.ids.traceId(),
      });
    } catch (error) {
      this.#options.logger?.log("error", "cycle_adoption_failed", {
        turnId: turn.turnId,
        cycleId,
        error: error instanceof Error ? error.message : "unknown",
      });
      turn.result = "failed";
      return;
    }
    turn.adoptedCount += 1;
    turn.degraded = true;
    turn.finishReason = label;
    turn.lastConsumedTo = watermarkTo;
    this.#options.metrics?.counter("bellis_decision_cycles_total", { result: "degraded" }).inc();
    this.#options.onWatermarkConsumed?.(watermarkTo);
    turn.status = "finishing";
  }

  async #runCycle(turn: TurnState): Promise<CycleOutcome> {
    const cycleId = this.#options.ids.cycleId();
    const requestId = this.#options.ids.requestId();
    const traceId = this.#options.ids.traceId();
    // snapshot：合并 next_cycle 缓冲（区间并集保持连续）。
    let batch = turn.snapshotBatch;
    while (turn.merged.length > 0 && batch !== null) {
      const next = turn.merged.shift();
      if (next !== undefined) {
        batch = mergeBatches(batch, next);
      }
    }
    if (batch === null) {
      // 无新输入的后续 Cycle：lastConsumedTo 的幂等空区间（不吞输入）。
      const at = turn.lastConsumedTo;
      batch = {
        schemaVersion: 1,
        id: this.#options.ids.batchId(),
        watermarkFrom: at.toString(10),
        watermarkTo: at.toString(10),
        highlights: [],
        topics: [],
        urgentSignals: [],
        tokenEstimate: 0,
      };
    }
    // snapshotBatch 保留到 adoption 成功才清空：中断时未采用区间可回收。
    turn.snapshotBatch = batch;
    const snapshot: CycleSnapshot = {
      schemaVersion: 1,
      turnId: turn.turnId,
      cycleId,
      cycleIndex: turn.adoptedCount,
      maxCyclesPerTurn: this.#config.maxCyclesPerTurn,
      batch,
      pendingToolResults: turn.pendingToolResults,
      recentSpeech: turn.recentSpeech,
      toolResultsTruncated: false,
    };
    // ── requesting ──
    const request = buildModelRequest({
      requestId,
      snapshot,
      provider: this.#options.provider.name,
      model: this.#options.model,
      tools: this.#options.tools.listDeclarations().map(buildToolModelSpec),
      instructions: this.#options.instructions,
    });
    const streamAbort = new AbortController();
    const onTurnAbort = () => streamAbort.abort(turn.abort.signal.reason);
    turn.abort.signal.addEventListener("abort", onTurnAbort, { once: true });
    const assembler = new StreamAssembler({
      cycleId,
      tools: request.tools,
      validateArguments: (toolName, args) => this.#options.tools.validateArguments(toolName, args),
      maxToolCalls: this.#config.maxParallelTools,
    });
    const startedUs = this.#options.clock.nowUs();
    const deadlineUs = startedUs + BigInt(this.#config.modelTimeoutMs) * 1_000n;
    const timeoutAbort = new AbortController();
    const onStreamAbort = () => timeoutAbort.abort(streamAbort.signal.reason);
    streamAbort.signal.addEventListener("abort", onStreamAbort, { once: true });
    const timeoutPromise = this.#options.clock
      .sleepUntil(deadlineUs, timeoutAbort.signal)
      .then(() => "timeout" as const)
      .catch(() => "aborted" as const);
    const streamPromise = this.#consumeStream(request, assembler, streamAbort.signal);
    const race = await Promise.race([
      streamPromise.then(() => "stream_done" as const),
      timeoutPromise,
    ]);
    let degradedReason: DegradationReason | null = null;
    let degradedDetail = "";
    let firstEventUs: bigint | null = null;
    if (race === "timeout") {
      // 失败分支真正 Abort（不是裸 Promise race）：中止 Provider 流。
      streamAbort.abort(new Error("model_timeout"));
      await streamPromise.catch(() => undefined);
      degradedReason = "timeout";
      degradedDetail = "model stream exceeded deadline";
    } else {
      timeoutAbort.abort(new Error("stream_completed"));
      const result = await streamPromise;
      firstEventUs = result.firstEventUs;
      if (result.error !== null) {
        degradedReason = turn.abort.signal.aborted ? "aborted" : "stream_broken";
        degradedDetail = result.error;
      }
    }
    streamAbort.signal.removeEventListener("abort", onStreamAbort);
    turn.abort.signal.removeEventListener("abort", onTurnAbort);
    const durationUs = this.#options.clock.nowUs() - startedUs;
    if (degradedReason === "aborted") {
      this.#options.audit?.modelRequest({
        cycleId,
        provider: this.#options.provider.name,
        outcome: "aborted",
        degradationReason: "aborted",
      });
      turn.result = "cancelled";
      return { kind: "cancel" };
    }
    // ── validating ──
    let packet: DecisionPacket | null = null;
    let degradedPacket = false;
    if (degradedReason === null) {
      const outcome = assembler.finish();
      if (outcome.ok) {
        packet = outcome.packet;
        this.#options.audit?.modelRequest({
          cycleId,
          provider: this.#options.provider.name,
          outcome: "final",
          ...(firstEventUs === null ? {} : { ttftMs: Number((firstEventUs - startedUs) / 1000n) }),
          durationMs: Number(durationUs / 1000n),
          ...(outcome.usage.inputTokens === undefined
            ? {}
            : { inputTokens: outcome.usage.inputTokens }),
          ...(outcome.usage.outputTokens === undefined
            ? {}
            : { outputTokens: outcome.usage.outputTokens }),
          ...(outcome.usage.cachedInputTokens === undefined
            ? {}
            : { cachedInputTokens: outcome.usage.cachedInputTokens }),
        });
      } else {
        degradedReason = "invalid_packet";
        degradedDetail = `${outcome.error.code}: ${outcome.error.detail}`;
      }
    }
    if (packet === null) {
      packet = buildSafetyPacket(
        cycleId,
        degradedReason ?? "invalid_packet",
        this.#options.degradationPolicy,
      );
      degradedPacket = true;
      turn.degraded = true;
      this.#options.audit?.modelRequest({
        cycleId,
        provider: this.#options.provider.name,
        outcome: degradedReason === "invalid_packet" ? "degraded" : "failed",
        degradationReason: degradedReason ?? "invalid_packet",
        durationMs: Number(durationUs / 1000n),
      });
    }
    // 交叉规则：after_tools 必须至少有一个前台 Tool；DAG 必须可编译。
    if (!degradedPacket && packet.next === "after_tools" && packet.toolCalls.length === 0) {
      packet = buildSafetyPacket(cycleId, "invalid_packet", this.#options.degradationPolicy);
      degradedPacket = true;
      degradedDetail = "after_tools without foreground tool calls";
    }
    if (!degradedPacket && packet.toolCalls.length > 0) {
      const dag = this.#options.tools.compileDag(packet.toolCalls);
      if (!dag.ok) {
        packet = buildSafetyPacket(cycleId, "invalid_packet", this.#options.degradationPolicy);
        degradedPacket = true;
        degradedDetail = `dag compile failed: ${dag.issues.map((issue) => issue.code).join(",")}`;
      }
    }
    if (degradedPacket) {
      turn.degraded = true;
      this.#options.logger?.log("warn", "model_stream_degraded", {
        cycleId,
        detail: degradedDetail.slice(0, 256),
      });
    }
    // ── adopting ──（失败 → 不推进水位/不执行 Tool/不提交 Scene）
    try {
      await this.#options.adoption.adoptCycle({
        turnId: turn.turnId,
        cycleId,
        cycleIndex: snapshot.cycleIndex,
        packet,
        packetDigest: packetDigest(packet),
        batchId: batch.id,
        watermarkFrom: BigInt(batch.watermarkFrom),
        watermarkTo: BigInt(batch.watermarkTo),
        degraded: degradedPacket,
        traceId,
      });
    } catch (error) {
      this.#options.logger?.log("error", "cycle_adoption_failed", {
        turnId: turn.turnId,
        cycleId,
        error: error instanceof Error ? error.message : "unknown",
      });
      this.#options.metrics?.counter("bellis_decision_cycles_total", { result: "failed" }).inc();
      this.#options.audit?.cycleFinished({
        turnId: turn.turnId,
        cycleId,
        result: "failed",
        next: packet.next,
        sceneSubmitted: false,
      });
      return { kind: "fail" };
    }
    turn.adoptedCount += 1;
    turn.snapshotBatch = null;
    turn.lastConsumedTo = BigInt(batch.watermarkTo);
    this.#options.metrics
      ?.counter("bellis_decision_cycles_total", {
        result: degradedPacket ? "degraded" : "adopted",
      })
      .inc();
    this.#options.onWatermarkConsumed?.(BigInt(batch.watermarkTo));
    if ("speech" in packet.action && packet.action.speech !== undefined) {
      turn.recentSpeech = [
        ...turn.recentSpeech,
        {
          schemaVersion: 1 as const,
          cycleId,
          text: packet.action.speech.text,
          purpose: packet.action.speech.purpose,
        },
      ].slice(-8);
    }
    // ── dispatching：Scene 与 Tool 并行（不变量 5；不等待 Scene done）──
    let sceneSubmitted = false;
    const sceneResult = this.#options.performance.submitDecision(packet, {
      traceId,
      turnId: turn.turnId,
      cycleId,
      cycleIndex: snapshot.cycleIndex,
      signal: turn.abort.signal,
    });
    if (sceneResult.kind === "scene_submitted") {
      sceneSubmitted = true;
      this.#trackBackground(sceneResult.done.then((outcome) => outcome));
    }
    if (packet.toolCalls.length > 0) {
      const dag = this.#options.tools.compileDag(packet.toolCalls);
      if (dag.ok) {
        const execution = await this.#options.tools.executeDag(dag, {
          traceId,
          sessionId: this.#options.sessionId,
          turnId: turn.turnId,
          cycleId,
          signal: turn.abort.signal,
          capabilities: this.#options.capabilities ?? new Set<string>(),
          idempotencyKeys: new Map(
            packet.toolCalls
              .filter((call) => call.idempotencyKey !== undefined)
              .map((call) => [call.toolRunId, call.idempotencyKey as string]),
          ),
          maxParallelTools: this.#config.maxParallelTools,
        });
        this.#trackBackgroundSet(execution.background);
        if (packet.next === "after_tools") {
          // 工具结果只进后续 Cycle（不变量 6）。
          turn.pendingToolResults = [...execution.results];
        } else {
          turn.pendingToolResults = [];
        }
      }
    } else {
      turn.pendingToolResults = [];
    }
    // ── awaiting_next ──
    let next = packet.next;
    if (next === "continue") {
      const hadNewInput = batch.highlights.length > 0 || batch.urgentSignals.length > 0;
      if (!hadNewInput && turn.pendingToolResults.length === 0) {
        turn.idleSpins += 1;
        if (turn.idleSpins >= this.#config.idleSpinLimit) {
          await this.#finishWithSafety(turn, "invalid_packet", "idle_spin");
          next = "finish";
        }
      } else {
        turn.idleSpins = 0;
      }
    }
    this.#options.audit?.cycleFinished({
      turnId: turn.turnId,
      cycleId,
      result: "completed",
      next: packet.next,
      sceneSubmitted,
    });
    if (next === "finish") {
      turn.status = "finishing";
    }
    return { kind: "advance", next };
  }

  #trackBackground(promise: Promise<unknown>): void {
    const guarded = promise.catch(() => undefined);
    this.#backgroundTasks.add(guarded);
    void guarded.finally(() => this.#backgroundTasks.delete(guarded));
  }

  #trackBackgroundSet(promises: readonly Promise<unknown>[]): void {
    for (const promise of promises) {
      this.#trackBackground(promise);
    }
  }

  async #consumeStream(
    request: ModelRequest,
    assembler: StreamAssembler,
    signal: AbortSignal,
  ): Promise<{ readonly error: string | null; readonly firstEventUs: bigint | null }> {
    const clock = this.#options.clock;
    let firstEventUs: bigint | null = null;
    try {
      const stream = this.#options.provider.streamDecision(request, signal);
      for await (const event of stream) {
        if (firstEventUs === null) {
          firstEventUs = clock.nowUs();
        }
        if (!assembler.push(event)) {
          break;
        }
      }
      return { error: null, firstEventUs };
    } catch (error) {
      if (signal.aborted) {
        return {
          error: `aborted: ${signal.reason instanceof Error ? signal.reason.message : "cancel"}`,
          firstEventUs,
        };
      }
      return {
        error: error instanceof Error ? error.message : "stream error",
        firstEventUs,
      };
    }
  }
}
