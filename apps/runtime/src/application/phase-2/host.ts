import type {
  ActiveSceneState,
  MonotonicClock,
  Phase1SessionSnapshot,
  Phase2SessionSnapshot,
  StageCapabilities,
} from "@bellis/contracts";
import type { ActiveSceneRow } from "@bellis/persistence";

/** 跨进程对账证据（活动 Scene 索引行；持久化层写侧同事务维护）。 */
import { buildPhase2SessionSnapshot } from "../recovery.js";
import type { RecoveryState } from "@bellis/persistence";
import type {
  CompileIdSource,
  DirectorFaultPoint,
  SceneRepositoryPort,
} from "@bellis/scene-runtime";
import type { LoggerPort, MetricsPort } from "@bellis/observability";
import type { ControlConnection } from "../../websocket/control-adapter.js";
import type { MediaConnection } from "../../websocket/media-adapter.js";
import type { ControlChannel } from "./stage-port-adapter.js";
import {
  Phase2PerformanceService,
  type MediaOutboundChannel,
  type Phase2AuditPort,
  type SubmissionOutcome,
} from "./performance-service.js";
import type { FakeModelFixture } from "./fake-model.js";

/**
 * Phase 2 Runtime Host（开发/Demo 装配，docs/phase-2-development-guide.md §9.1）。
 *
 * - 把 Phase2PerformanceService 绑定到当前 Stage 类型的 ControlConnection：
 *   出站走 sendPhase2Message（协议优先级入队），入站经 onStageMessage 钩子；
 * - 媒体出站绑定当前 Session 的 MediaConnection（sendFrame 编码 BELL v1），
 *   连接关闭即解绑并停止全部帧任务（Stream 不跨连接复活）；
 * - 只在显式启用（development/test 配置）时由 startRuntime 装配；生产
 *   默认路径不创建本对象；
 * - 同一时刻只绑定一条 Stage 连接：新连接取代旧连接（旧连接关闭即解绑）。
 */

export interface Phase2HostOptions {
  readonly sessionId: string;
  readonly capabilities: StageCapabilities;
  readonly clock: MonotonicClock;
  readonly wallClockMs: () => number;
  readonly compileIds: CompileIdSource;
  readonly recordId: () => string;
  readonly repository: SceneRepositoryPort;
  readonly logger?: LoggerPort;
  readonly metrics?: MetricsPort;
  readonly audit?: Phase2AuditPort;
  /** SessionId 解析成功（Stage 连接出现）时回调（审计 Record 绑定会话）。 */
  readonly onSessionIdResolved?: (sessionId: string) => void;
  readonly runtimeVersion?: string;
  /** Director 故障注入钩子（开发/Demo 崩溃窗口测试；缺省零开销）。 */
  readonly directorFaultHook?: (point: DirectorFaultPoint) => void;
}

export class Phase2RuntimeHost {
  readonly #service: Phase2PerformanceService;
  readonly #options: Phase2HostOptions;
  #connection: ControlConnection | null = null;
  #mediaConnection: MediaConnection | null = null;
  readonly #mediaDisconnectHandlers: (() => void)[] = [];
  readonly #disconnectHandlers: (() => void)[] = [];
  /** 当前绑定的 Stage 逻辑 Session（首个 clientType=stage hello 决定）。 */
  #stageSessionId: string | null = null;
  #closed = false;

  constructor(options: Phase2HostOptions) {
    this.#options = options;
    const channel: ControlChannel = {
      enqueueServerMessage: (input) =>
        this.#connection?.sendPhase2Message({
          type: input.type,
          payload: input.payload,
          traceId: input.trace.traceId,
        }) ?? false,
      hasStageConnection: () => this.#connection !== null && !this.#closed,
      onDisconnected: (handler) => {
        this.#disconnectHandlers.push(handler);
      },
    };
    const mediaChannel: MediaOutboundChannel = {
      sendFrame: (frame) =>
        this.#mediaConnection?.sendFrame({
          header: frame.header as never,
          payload: frame.payload,
          mediaKind: "audio",
        }) ?? false,
      onDisconnected: (handler) => {
        this.#mediaDisconnectHandlers.push(handler);
      },
    };
    this.#service = new Phase2PerformanceService({
      sessionId: options.sessionId,
      capabilities: options.capabilities,
      clock: options.clock,
      wallClockMs: options.wallClockMs,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
      compileIds: options.compileIds,
      recordId: options.recordId,
      channel,
      repository: options.repository,
      mediaChannel,
      ...(options.audit === undefined ? {} : { audit: options.audit }),
      ...(options.onSessionIdResolved === undefined
        ? {}
        : { onSessionIdResolved: options.onSessionIdResolved }),
      ...(options.directorFaultHook === undefined
        ? {}
        : { directorFaultHook: options.directorFaultHook }),
    });
  }

  get service(): Phase2PerformanceService {
    return this.#service;
  }

  /**
   * Stage 连接建立（server 装配在 ControlConnection 创建后调用）。
   * 首个 clientType=stage hello 决定归属 Session；此后其它 Session 的
   * stage hello 不再改绑（隔离：防止第二条会话劫持演出连接与媒体流）。
   */
  attachConnection(connection: ControlConnection, sessionId?: string): void {
    if (
      sessionId !== undefined &&
      this.#stageSessionId !== null &&
      sessionId !== this.#stageSessionId
    ) {
      this.#options.logger?.log("warn", "phase2_stage_rebind_rejected", {
        boundSessionId: this.#stageSessionId,
        attemptedSessionId: sessionId,
      });
      return;
    }
    if (sessionId !== undefined) {
      this.#stageSessionId = sessionId;
    }
    this.#connection = connection;
    this.#service.markStageConnected(sessionId);
  }

  /** 连接关闭（server 装配注册的 close 钩子调用）。 */
  detachConnection(connection: ControlConnection): void {
    if (this.#connection === connection) {
      this.#connection = null;
      // 绑定随建立它的连接存亡：归属连接关闭即释放 Session 归属
      //（后续 Session 可依序改绑；连接存续期间改绑仍被拒绝）。
      this.#stageSessionId = null;
      for (const handler of Array.from(this.#disconnectHandlers)) {
        handler();
      }
    }
  }

  /**
   * Media 连接是否可绑定到给定 Session：只有当前绑定的 Stage Session
   * 允许（隔离：其它 Session 的 Media WS 不得替换 Stage 媒体连接或
   * 接收 PCM）。Stage hello 先于 Media 连接到达是装配前置条件。
   */
  acceptsMediaSession(sessionId: string): boolean {
    return !this.#closed && this.#stageSessionId === sessionId;
  }

  /** Media 连接建立（server 装配在 MediaConnection 创建后调用）。 */
  attachMediaConnection(connection: MediaConnection): void {
    this.#mediaConnection = connection;
  }

  /** Media 连接关闭：解绑并通知发送器停止全部帧任务。 */
  detachMediaConnection(connection: MediaConnection): void {
    if (this.#mediaConnection === connection) {
      this.#mediaConnection = null;
      for (const handler of Array.from(this.#mediaDisconnectHandlers)) {
        handler();
      }
    }
  }

  /** ControlConnection.onStageMessage 入口（仅当前绑定连接的回执进入状态机）。 */
  handleStageMessage(envelope: { type: string; payload: unknown }, nowUs: bigint): void {
    this.#service.handleStageMessage(envelope.type, envelope.payload, nowUs);
  }

  /** 连接归属：是否为当前绑定的 Stage ControlConnection（入站回执判据）。 */
  ownsConnection(connection: ControlConnection): boolean {
    return this.#connection === connection && !this.#closed;
  }

  /** Session 归属：快照装饰只对绑定的 Stage Session 生效（隔离）。 */
  ownsSession(sessionId: string): boolean {
    return !this.#closed && this.#stageSessionId === sessionId;
  }

  /**
   * Snapshot 装饰（scene-execution.md §8）：存在对账价值的活动 Scene
   * （未完成或 uncertain）时升级为 v2 形态并补 requiresReprepare
   * （= 当前无 Stage 连接：准备资源已随旧连接丢失）；否则原样返回 v1。
   * 同步实现（恢复状态由调用方预加载），保持「快照必须成功入队」不变量。
   *
   * 跨进程（重启后无 Director 状态）：durable 落库 Scene 以预加载的
   * 生命周期 Record 为证据——最后记录已达终态（completed/cancelled/
   * failed）即无对账价值（v1）；记录缺失、未达终态或为 uncertain 时，
   * 结果不可证明 → v2 uncertain 视图（requiresReprepare=true，绝不虚构
   * 其它执行状态，也绝不自动重播）。
   */
  decorateSnapshot(
    base: Phase1SessionSnapshot,
    recoveryState: RecoveryState,
    activeScenes: readonly ActiveSceneRow[] | null = null,
  ): Phase1SessionSnapshot | Phase2SessionSnapshot {
    const view = this.#service.activeSceneView();
    if (view === null) {
      const crossProcess = this.#crossProcessView(recoveryState, activeScenes);
      return crossProcess === null ? base : buildPhase2SessionSnapshot(recoveryState, crossProcess);
    }
    return buildPhase2SessionSnapshot(recoveryState, {
      reason: base.reason,
      sessionStatus: base.sessionStatus,
      runtimeVersion: this.#options.runtimeVersion ?? base.runtimeVersion,
      generatedAtMs: Date.now(),
      activeScene: {
        sceneId: view.sceneId,
        cycleId: view.cycleId,
        executionState: view.executionState as never,
        outcomeCertain: view.outcomeCertain,
        // uncertain = Stage 侧结果不可知（旧连接已丢失）：对账后必须重新
        // Prepare 才能重播；未完成且连接健在的 Scene 无需重新准备。
        requiresReprepare: view.executionState === "uncertain" || this.#connection === null,
      },
    });
  }

  /**
   * 跨进程对账视图构造参数；无对账价值（无落库/索引为空）返回 null。
   *
   * 证据规则（scene-execution.md §8）：
   * - 活动 Scene 索引由持久化层在 scene_lifecycle Record 落库的同事务内
   *   维护（非终态 UPSERT、可证终态 DELETE、payload 不可验证保守保留
   *   为 unknown）——「任一未证终态」直接由索引回答，不受记录窗口
   *   挤出影响；
   * - "committing" 存在落库歧义（崩溃可发生在 durable 前后）：lastCommittedScene
   *   只证明最新提交者，不能证明其它 Scene 未提交——非锚点的 committing
   *   行由索引行的 durable 位（scenes 表存在已提交行）逐候选裁决：
   *   durable → 已提交但后续生命周期未落库（未证终态，计入）；非 durable
   *   → 提交从未生效（Scene 从未存在，安全忽略）；
   * - 索引不可读（null，防御路径：装配层 loader 失败已 fail-closed）：
   *   「无法证明」绝不误报为「无活动」——存在最后落库 Scene 即以锚点
   *   保守构造 v2 uncertain；
   * - unknown 状态 = payload 版本不可验证：绝不静默当作已知格式；
   *   无法构造合法视图（cycleId 未知且非锚点 Scene）时跳过并告警。
   */
  #crossProcessView(
    recoveryState: RecoveryState,
    activeScenes: readonly ActiveSceneRow[] | null,
  ): {
    readonly reason: Phase1SessionSnapshot["reason"];
    readonly sessionStatus: Phase1SessionSnapshot["sessionStatus"];
    readonly runtimeVersion: string;
    readonly generatedAtMs: number;
    readonly activeScene: ActiveSceneState;
  } | null {
    const committed = recoveryState.lastCommittedScene;
    if (committed === null) {
      return null;
    }
    const uncertainView = (sceneId: string, cycleId: string) => ({
      reason: "replay_gap" as const,
      sessionStatus: "ready" as const,
      runtimeVersion: this.#options.runtimeVersion ?? "unknown",
      generatedAtMs: Date.now(),
      activeScene: {
        sceneId,
        cycleId,
        executionState: "uncertain" as const,
        outcomeCertain: false,
        requiresReprepare: true,
      },
    });
    if (activeScenes === null) {
      return uncertainView(committed.sceneId, committed.cycleId);
    }
    const candidates: { sceneId: string; cycleId: string; updatedAtMs: number }[] = [];
    for (const row of activeScenes) {
      if (row.state === "committing" && row.sceneId !== committed.sceneId && !row.durable) {
        continue;
      }
      const cycleId = row.cycleId ?? (row.sceneId === committed.sceneId ? committed.cycleId : null);
      if (cycleId === null) {
        this.#options.logger?.log("warn", "phase2_recovery_evidence_incomplete", {
          sceneId: row.sceneId,
          state: row.state,
        });
        continue;
      }
      candidates.push({ sceneId: row.sceneId, cycleId, updatedAtMs: row.updatedAtMs });
    }
    if (candidates.length === 0) {
      return null;
    }
    const chosen = candidates.reduce((left, right) =>
      right.updatedAtMs > left.updatedAtMs ? right : left,
    );
    return uncertainView(chosen.sceneId, chosen.cycleId);
  }

  submit(input: { signal: unknown; fixture: FakeModelFixture }): SubmissionOutcome {
    return this.#service.submit(input);
  }

  async interruptAll(reason: string): Promise<void> {
    await this.#service.interruptAll(reason);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#mediaConnection = null;
    await this.#service.close();
  }
}
