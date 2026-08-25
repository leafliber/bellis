import type {
  MonotonicClock,
  Phase1SessionSnapshot,
  Phase2SessionSnapshot,
  StageCapabilities,
} from "@bellis/contracts";
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

  /**
   * Snapshot 装饰（scene-execution.md §8）：存在对账价值的活动 Scene
   * （未完成或 uncertain）时升级为 v2 形态并补 requiresReprepare
   * （= 当前无 Stage 连接：准备资源已随旧连接丢失）；否则原样返回 v1。
   */
  /**
   * Snapshot 装饰（scene-execution.md §8）：存在对账价值的活动 Scene
   * （未完成或 uncertain）时升级为 v2 形态并补 requiresReprepare
   * （= 当前无 Stage 连接：准备资源已随旧连接丢失）；否则原样返回 v1。
   * 同步实现（恢复状态由调用方预加载），保持「快照必须成功入队」不变量。
   */
  decorateSnapshot(
    base: Phase1SessionSnapshot,
    recoveryState: RecoveryState,
  ): Phase1SessionSnapshot | Phase2SessionSnapshot {
    const view = this.#service.activeSceneView();
    if (view === null) {
      return base;
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
