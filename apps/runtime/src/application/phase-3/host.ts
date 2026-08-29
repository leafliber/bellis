import { randomUUID } from "node:crypto";
import { PHASE_2_PCM_CONTENT_TYPE } from "@bellis/contracts";
import type { AudienceBatch, MonotonicClock, StageCapabilities } from "@bellis/contracts";
import type { PersistenceClient } from "@bellis/persistence";
import {
  DecisionLoop,
  SignalPipeline,
  type DecisionLoopConfig,
  type IngestResult,
  type ModelProvider,
  type PerformancePort,
  type TurnOwnerPort,
  type TurnResult,
} from "@bellis/decision-loop";
import { StandardToolRuntime } from "@bellis/tool-runtime";
import type { ToolCacheStore } from "@bellis/tool-runtime";
import type { ControlChannel } from "../phase-2/stage-port-adapter.js";
import type { SceneRepositoryPort } from "@bellis/scene-runtime";
import { Phase2PerformanceService } from "../phase-2/performance-service.js";
import { PerformancePortAdapter } from "../performance/port-adapter.js";
import {
  DurableCycleAdoption,
  DurableSignalStore,
  DurableToolCacheStore,
  Phase3AuditRecorder,
} from "./adapters.js";
import { createDemoToolState, registerDemoTools } from "./demo-tools.js";
import type { LoggerPort, MetricsPort } from "@bellis/observability";

/**
 * Phase 3 Decision Host（phase-3-development-guide.md §9.2）。
 *
 * ```text
 * authenticated dev signal input
 *   → SignalPipeline(Ingress/Batcher/Trigger) → DecisionLoop
 *   → ModelProvider + ToolRuntime + PerformancePort(Phase2 演出链路)
 *   → Persistence / Observability
 * ```
 *
 * - 一 Session 一 Loop 所有者；关闭顺序从 Ingress 向子任务传播；
 * - Session 归属沿用 Phase 2 Stage 绑定规则（bindSessionId）；
 * - 启动时执行恢复投影：未消费 Signal 重建窗口、非幂等 running
 *   Tool Run 标记 uncertain（绝不自动重试）。
 */
export interface Phase3HostOptions {
  readonly sessionId: string;
  readonly clock: MonotonicClock;
  readonly wallClockMs: () => number;
  readonly persistence: PersistenceClient;
  readonly provider: ModelProvider;
  readonly model: string;
  readonly instructions: string;
  readonly logger?: LoggerPort;
  readonly metrics?: MetricsPort;
  readonly loopConfig?: Partial<DecisionLoopConfig>;
  /** Session/Profile 授予的 Capability（Tool 权限门）。 */
  readonly grantedCapabilities?: readonly string[];
  readonly toolDurationUs?: bigint;
  /**
   * 演出服务：生命周期装配传入共享的 Phase2RuntimeHost.service
   *（Stage/Media 绑定由 Phase 2 宿主继续持有）；缺省时自建独立实例
   *（集成测试/Demo 子进程装配）。
   */
  readonly performanceService?: Phase2PerformanceService;
}

/** 独立装配的空出站/仓储（无 Stage 连接：Control 入队恒失败即视为无连接）。 */
function noopChannel(): ControlChannel {
  return {
    enqueueServerMessage: () => false,
    hasStageConnection: () => false,
    onDisconnected: () => undefined,
  };
}

async function rejectNoRepository(): Promise<never> {
  throw new Error("phase3 standalone assembly has no scene repository");
}

function noopRepository(): SceneRepositoryPort {
  return {
    commit: rejectNoRepository,
    appendLifecycle: rejectNoRepository,
  };
}

/** 独立装配（无 Stage 连接）时的回落能力：PCM 基线 + 字幕 + Avatar。 */
const FALLBACK_STAGE_CAPABILITIES: StageCapabilities = {
  schemaVersion: 1,
  audio: { contentTypes: [PHASE_2_PCM_CONTENT_TYPE], maxBufferedUs: "2000000" },
  subtitle: { supported: true },
  avatar: { adapter: "fake-demo", motions: ["nod_agree"], expressions: ["happy"] },
};

interface LateBoundOwner {
  readonly port: TurnOwnerPort;
  bind(owner: TurnOwnerPort): void;
}

function lateBoundOwner(): LateBoundOwner {
  let target: TurnOwnerPort | null = null;
  return {
    port: {
      isIdle: () => target?.isIdle() ?? true,
      cancelActiveTurn: () => target?.cancelActiveTurn() ?? [],
      startTurn: (batch: AudienceBatch, trigger: "normal_batch" | "interrupt" | "next_turn") =>
        target?.startTurn(batch, trigger) ?? false,
      mergeIntoNextCycle: (batch: AudienceBatch) => target?.mergeIntoNextCycle(batch) ?? false,
    },
    bind(owner: TurnOwnerPort): void {
      target = owner;
    },
  };
}

/** Demo/验收证据快照（phase-3-development-guide.md §10.2 证据行来源）。 */
export interface Phase3Evidence {
  readonly requested: number;
  readonly adopted: number;
  readonly degraded: number;
  readonly toolRuns: readonly {
    readonly toolRunId: string;
    readonly toolName: string;
    readonly outcome: string | null;
    readonly cacheSource: string | null;
    readonly startedAtUs: bigint | null;
    readonly finishedAtUs: bigint | null;
  }[];
  readonly sceneSpans: readonly {
    readonly sceneId: string;
    readonly submittedAtUs: bigint;
    readonly settledAtUs: bigint | null;
  }[];
  readonly ingest: readonly { readonly result: string; readonly sequence: string | null }[];
}

export class Phase3DecisionHost {
  readonly #options: Phase3HostOptions;
  readonly #signalStore: DurableSignalStore;
  readonly #adoption: DurableCycleAdoption;
  readonly #audit: Phase3AuditRecorder;
  readonly #tools: StandardToolRuntime;
  readonly #performance: Phase2PerformanceService;
  readonly #loop: DecisionLoop;
  readonly #pipeline: SignalPipeline;
  readonly #owner: LateBoundOwner;
  readonly #triggerSink: {
    notifyOwnerIdle(): void;
    requeueFront(batches: readonly AudienceBatch[]): void;
  };
  readonly demoState = createDemoToolState();
  readonly #evidence = {
    requested: 0,
    adopted: 0,
    degraded: 0,
    toolRuns: new Map<
      string,
      { toolName: string; outcome: string | null; cacheSource: string | null; startedAtUs: bigint | null; finishedAtUs: bigint | null }
    >(),
    sceneSpans: [] as { sceneId: string; submittedAtUs: bigint; settledAtUs: bigint | null }[],
    ingest: [] as { result: string; sequence: string | null }[],
  };
  #sessionId: string;
  #started = false;
  #closed = false;
  /** 恢复证据（P5 Demo 输出）。 */
  recoveryEvidence: { uncertainMarked: number; pendingRebuilt: number } | null = null;

  constructor(options: Phase3HostOptions) {
    this.#options = options;
    this.#sessionId = options.sessionId;
    const adapterOptions = {
      persistence: options.persistence,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      normalCapacity: 256,
      urgentCapacity: 32,
    };
    this.#signalStore = new DurableSignalStore(adapterOptions, this.#sessionId);
    this.#adoption = new DurableCycleAdoption(adapterOptions, this.#sessionId);
    this.#audit = new Phase3AuditRecorder(
      {
        persistence: options.persistence,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      },
      this.#sessionId,
    );
    const cacheStore: ToolCacheStore | null = new DurableToolCacheStore(options.persistence);
    this.#tools = new StandardToolRuntime({
      clock: options.clock,
      wallClockMs: options.wallClockMs,
      cacheStore,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
      onRunEvent: (event) => {
        const tracked = this.#evidence.toolRuns.get(event.toolRunId) ?? {
          toolName: event.toolName,
          outcome: null,
          cacheSource: null,
          startedAtUs: null,
          finishedAtUs: null,
        };
        if (event.transition === "started") {
          tracked.startedAtUs = options.clock.nowUs();
        }
        if (event.transition === "finished") {
          tracked.finishedAtUs = options.clock.nowUs();
          tracked.outcome = event.state ?? "succeeded";
          tracked.cacheSource = event.cacheSource ?? null;
        }
        this.#evidence.toolRuns.set(event.toolRunId, tracked);
        this.#audit.toolRun({
          toolRunId: event.toolRunId,
          cycleId: event.cycleId,
          toolName: event.toolName,
          transition: event.transition,
          ...(event.state === undefined ? {} : { state: event.state }),
          ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
          ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
          ...(event.idempotencyKeyHash === undefined
            ? {}
            : { idempotencyKeyHash: event.idempotencyKeyHash }),
        });
      },
    });
    registerDemoTools(this.#tools, {
      state: this.demoState,
      clock: options.clock,
      ...(options.toolDurationUs === undefined ? {} : { durationUs: options.toolDurationUs }),
    });
    this.#performance =
      options.performanceService ??
      new Phase2PerformanceService({
        sessionId: this.#sessionId,
        capabilities: FALLBACK_STAGE_CAPABILITIES,
        clock: options.clock,
        wallClockMs: options.wallClockMs,
        compileIds: { nextId: () => randomUUID() },
        recordId: () => randomUUID(),
        channel: noopChannel(),
        repository: noopRepository(),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
        ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
      });
    this.#owner = lateBoundOwner();
    const settledTurns: { turnId: string; result: TurnResult }[] = [];
    this.#loop = new DecisionLoop({
      sessionId: this.#sessionId,
      provider: {
        name: options.provider.name,
        streamDecision: (request, signal) => {
          this.#evidence.requested += 1;
          return options.provider.streamDecision(request, signal);
        },
      },
      tools: this.#tools,
      adoption: {
        adoptCycle: async (input) => {
          await this.#adoption.adoptCycle(input);
          this.#evidence.adopted += 1;
          if (input.degraded) {
            this.#evidence.degraded += 1;
          }
        },
      },
      performance: this.#instrumentedPerformance(),
      clock: options.clock,
      ids: {
        turnId: () => randomUUID(),
        cycleId: () => randomUUID(),
        requestId: () => randomUUID(),
        batchId: () => randomUUID(),
        traceId: () => randomUUID().replaceAll("-", "").slice(0, 32),
      },
      instructions: options.instructions,
      model: options.model,
      ...(options.loopConfig === undefined ? {} : { config: options.loopConfig }),
      capabilities: new Set(options.grantedCapabilities ?? ["gift.send"]),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
      audit: this.#audit,
      onWatermarkConsumed: (watermarkTo) => {
        this.#pipeline.markConsumed(watermarkTo);
      },
      onTurnSettled: (turnId, result) => {
        settledTurns.push({ turnId, result });
        this.#triggerSink.notifyOwnerIdle();
      },
      onUnadoptedReturn: (batches) => this.#triggerSink.requeueFront(batches),
    });
    this.#triggerSink = {
      notifyOwnerIdle: () => {
        this.#pipeline?.notifyOwnerIdle();
      },
      requeueFront: (batches) => {
        this.#pipeline?.requeueFront(batches);
      },
    };
    this.#owner.bind(this.#loop);
    this.#pipeline = new SignalPipeline({
      sessionId: this.#sessionId,
      clock: options.clock,
      wallClockMs: options.wallClockMs,
      store: this.#signalStore,
      owner: this.#owner.port,
      nextBatchId: () => randomUUID(),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    });
  }

  get performanceService(): Phase2PerformanceService {
    return this.#performance;
  }

  get toolRuntime(): StandardToolRuntime {
    return this.#tools;
  }

  get loop(): DecisionLoop {
    return this.#loop;
  }

  get pipeline(): SignalPipeline {
    return this.#pipeline;
  }

  /** 模型 Provider（Demo harness 注入脚本/断言请求）。 */
  get modelProvider(): ModelProvider {
    return this.#options.provider;
  }

  /** 启动：恢复投影 + 管道启动。 */
  async start(): Promise<void> {
    if (this.#started || this.#closed) {
      return;
    }
    this.#started = true;
    const recovery = await this.#signalStore.readDecisionState();
    this.recoveryEvidence = {
      uncertainMarked: recovery.uncertainMarked,
      pendingRebuilt: 0,
    };
    await this.#pipeline.start();
    const restored = await this.#signalStore.restore();
    this.recoveryEvidence.pendingRebuilt = restored.pending.length;
  }

  ingest(input: unknown): Promise<IngestResult> {
    const result = this.#pipeline.ingest(input);
    void result.then((value) => {
      this.#evidence.ingest.push({
        result: value.result,
        sequence:
          value.result === "accepted" || value.result === "deduplicated"
            ? value.sequence.toString(10)
            : null,
      });
    });
    return result;
  }

  /** 证据快照（Demo/验收）。 */
  evidence(): Phase3Evidence {
    return {
      requested: this.#evidence.requested,
      adopted: this.#evidence.adopted,
      degraded: this.#evidence.degraded,
      toolRuns: [...this.#evidence.toolRuns.entries()].map(([toolRunId, entry]) => ({
        toolRunId,
        ...entry,
      })),
      sceneSpans: this.#evidence.sceneSpans.map((span) => ({ ...span })),
      ingest: this.#evidence.ingest.map((entry) => ({ ...entry })),
    };
  }

  #instrumentedPerformance(): PerformancePort {
    const adapter = new PerformancePortAdapter(this.#performance);
    return {
      submitDecision: (packet, context) => {
        const result = adapter.submitDecision(packet, context);
        if (result.kind === "scene_submitted") {
          const span = {
            sceneId: result.sceneId,
            submittedAtUs: this.#options.clock.nowUs(),
            settledAtUs: null as bigint | null,
          };
          this.#evidence.sceneSpans.push(span);
          void result.done.finally(() => {
            span.settledAtUs = this.#options.clock.nowUs();
          });
        }
        return result;
      },
      interruptActiveScenes: (reason: string) => adapter.interruptActiveScenes(reason),
    };
  }

  /** 决策域恢复投影（Demo/验收：水位、Cycle、Tool Run 状态）。 */
  async readDecisionState() {
    return this.#signalStore.readDecisionState();
  }

  /** Stage 连接出现：绑定真实逻辑 Session（Phase 2 规则）。 */
  bindSessionId(sessionId: string): void {
    this.#sessionId = sessionId;
    this.#signalStore.bindSessionId(sessionId);
    this.#adoption.bindSessionId(sessionId);
    this.#audit.bindSessionId(sessionId);
    this.#performance.markStageConnected(sessionId);
  }

  handleStageMessage(type: string, payload: unknown, nowUs: bigint): void {
    this.#performance.handleStageMessage(type, payload, nowUs);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    // 关闭顺序：Ingress/窗口/触发器 → Loop 子任务 → Tool → 演出 → 无等待者。
    await this.#pipeline.close();
    await this.#loop.close("phase3_host_close");
    await this.#tools.close("phase3_host_close");
    await this.#performance.close();
  }
}
