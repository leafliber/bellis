import type {
  DecisionPacket,
  JsonValue,
  MonotonicClock,
  ScenePlan,
  SpeechIntent,
  StageCapabilities,
} from "@bellis/contracts";
import {
  MediaStreamReadyPayloadSchema,
  PHASE_2_AUDIT_PAYLOAD_VERSION,
  PHASE_2_PCM_CONTENT_TYPE,
  SignalSchema,
  SpeechIntentSchema,
  StageCapabilitiesSchema,
  TraceIdSchema,
} from "@bellis/contracts";
import type { LoggerPort, MetricsPort } from "@bellis/observability";
import {
  SceneDirector,
  compileActionFrame,
  type CompileIdSource,
  type CompileResult,
  type DirectorFaultPoint,
  type DirectorPolicy,
  type LaneFinishReport,
  type LaneStartReport,
  type SceneHandle,
  type SceneRepositoryPort,
} from "@bellis/scene-runtime";
import { runFakeModel, type FakeModelFixture } from "./fake-model.js";
import type { SpeechProvider } from "../performance/speech-provider.js";
import { RuntimeMediaSender, type OutboundMediaFrame } from "./media-sender.js";
import { ControlStagePortAdapter, type ControlChannel } from "./stage-port-adapter.js";

/**
 * Phase 2 演出应用服务（docs/phase-2-development-guide.md §9.2）。
 *
 * 编排链（新增命名服务，不扩展 Phase 1 的 FakeSceneCommitService）：
 *
 * ```text
 * validate Signal → Fake Model DecisionPacket → Action Compiler
 *   → media.stream.announce（speech 存在时）→ Director（Prepare → durable
 *   commitScene+plan → Stage Commit）→ media.stream.ready → PCM 帧流
 *   → 收集 started/finished（偏差指标）
 * ```
 *
 * - DecisionPacket 未经 Schema 校验通过即拒绝并记录（不进入编译）；
 * - 编译 rejected/noop 如实返回，不伪造 Scene；
 * - 媒体编排：announce 在 Director.submit 之前发出（Stage 音频 Lane 的
 *   prepare 等待预缓冲帧）；ready 后按 targetTimeUs 节奏发送 PCM；
 * - 取消优先于媒体：interrupt/终态立即停止该 Scene 的帧；
 * - 生命周期审计记录经 SceneRepositoryPort（append-only）；Signal/决策/
 *   编译事实经可选 Phase2AuditPort 落版本化 Record（不含发言全文）；
 * - 每次 submit 生成稳定 traceId，prepare/commit/cancel/媒体共用同一根。
 */

/** Runtime → Stage 媒体出站通道（Host 绑定当前 Media 连接）。 */
export interface MediaOutboundChannel {
  sendFrame(frame: OutboundMediaFrame): boolean;
  onDisconnected(handler: () => void): void;
}

/** 版本化审计 Record Port（payload 由调用方保证不含敏感全文）。 */
export interface Phase2AuditPort {
  append(record: {
    readonly recordType: string;
    readonly aggregateId: string;
    readonly payload: JsonValue;
    /** 提交链 trace 根（Signal→决策→编译共用；缺省由装配层提供）。 */
    readonly traceId?: string;
  }): Promise<void>;
}

/**
 * 出站流首帧目标提前量：须 ≤ Director commitLeadMs（提前缓冲，不超前
 * 播放）。取值权衡：越大播放前缓冲越足，但音频 Lane 的预缓冲达标
 * （prepare 语义）越晚——100ms 在 48k/20ms 帧下于 prepare 预算内
 * 完成 6 帧预缓冲且 commit 后仍有 ~300ms 缓冲提前量。
 */
const DEFAULT_MEDIA_START_LEAD_US = 100_000n;

export interface Phase2PerformanceServiceOptions {
  readonly sessionId: string;
  readonly capabilities: StageCapabilities;
  readonly clock: MonotonicClock;
  readonly wallClockMs: () => number;
  readonly logger?: LoggerPort;
  readonly metrics?: MetricsPort;
  readonly compileIds: CompileIdSource;
  readonly recordId: () => string;
  readonly channel: ControlChannel;
  readonly repository: SceneRepositoryPort;
  readonly directorPolicy?: Partial<DirectorPolicy>;
  /** Director 故障注入钩子（开发/Demo 崩溃窗口测试；缺省零开销）。 */
  readonly directorFaultHook?: (point: DirectorFaultPoint) => void;
  /** 媒体出站通道（缺省不编排 PCM 流，纯 Control 链路仍可用）。 */
  readonly mediaChannel?: MediaOutboundChannel;
  readonly speechProvider?: SpeechProvider;
  readonly mediaStartLeadUs?: bigint;
  /** Signal/决策/编译事实审计（缺省仅日志）。 */
  readonly audit?: Phase2AuditPort;
  /** SessionId 解析成功（Stage 连接出现）时回调（审计 Record 绑定会话）。 */
  readonly onSessionIdResolved?: (sessionId: string) => void;
}

export interface SignalSubmission {
  readonly signal: unknown;
  readonly fixture: FakeModelFixture;
}

export type SubmissionOutcome =
  | { readonly kind: "noop" }
  | { readonly kind: "rejected"; readonly issues: readonly { code: string }[] }
  | { readonly kind: "invalid_packet" }
  | { readonly kind: "invalid_signal" }
  | { readonly kind: "submitted"; readonly sceneId: string; readonly handle: SceneHandle };

interface PendingStream {
  readonly plan: ScenePlan;
  /** 懒合成：admission 通过且 Stage ready 后才物化完整 PCM。 */
  readonly speech: SpeechIntent;
  readonly audioCueId: string;
  readonly sessionId: string;
  readonly traceId: string;
}

/** plan 级 speech 扩展键读取（Compiler 的单一存放点，Schema 允许扩展）。 */
function readPlanSpeech(plan: { readonly speech?: unknown }): SpeechIntent | null {
  const check = SpeechIntentSchema.safeParse(plan.speech);
  return check.success ? check.data : null;
}

export class Phase2PerformanceService {
  readonly #director: SceneDirector;
  readonly #stagePort: ControlStagePortAdapter;
  readonly #options: Phase2PerformanceServiceOptions;
  readonly #mediaSender: RuntimeMediaSender;
  readonly #mediaStartLeadUs: bigint;
  #sessionId: string;
  readonly #activeScenes = new Map<
    string,
    { cycleId: string; startedAt: bigint | null; starts: Map<string, bigint> }
  >();
  /** 已 announce、等待 media.stream.ready 的流（≤ 活跃 Scene 上限，有界）。 */
  readonly #pendingStreams = new Map<string, PendingStream>();
  /** sceneId → 已 announce 的 Stream（终态/完成时发送 media.stream.closed）。 */
  readonly #sceneStreams = new Map<
    string,
    { readonly streamId: string; readonly traceId: string; finalSequence: bigint | null }
  >();
  /**
   * 未能送达的 closed（入队失败/断线）：连接恢复或下次关闭时冲刷。
   * 以 streamId 为键幂等去重；容量 ≤ 已 announce 流数（有界）。
   */
  readonly #pendingStreamClosures = new Map<
    string,
    {
      readonly sceneId: string;
      readonly sessionId: string;
      readonly reason: string;
      readonly finalSequence?: bigint;
      readonly traceId: string;
    }
  >();

  constructor(options: Phase2PerformanceServiceOptions) {
    this.#options = options;
    this.#sessionId = options.sessionId;
    this.#mediaStartLeadUs = options.mediaStartLeadUs ?? DEFAULT_MEDIA_START_LEAD_US;
    this.#stagePort = new ControlStagePortAdapter({
      channel: options.channel,
      clock: options.clock,
      nextMessageId: options.recordId,
    });
    this.#director = new SceneDirector({
      stage: this.#stagePort,
      repository: options.repository,
      clock: options.clock,
      wallClockMs: options.wallClockMs,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
      ...(options.directorPolicy === undefined ? {} : { policy: options.directorPolicy }),
      ...(options.directorFaultHook === undefined ? {} : { faultHook: options.directorFaultHook }),
    });
    this.#mediaSender = new RuntimeMediaSender({
      clock: options.clock,
      sendFrame: (frame) => options.mediaChannel?.sendFrame(frame) ?? false,
      // 流生命周期：自然完成/取消即关闭 Stream——Stage Registry 的并发
      // Stream 槽位（默认 8）必须释放，否则同一连接第 9 场 announce 被拒。
      // finalSequence = 已交送传输层的最大 Sequence：closed 经 Control 与
      // 帧（Media WS）跨连接送达无全局顺序——边界让先到的 closed 不丢
      // 乱序尾帧（超边界即拒）。
      onJobEnd: (info) => {
        // 完成/取消统一走带边界的关闭：interruptAll 等直接 cancelStream 的
        // 路径不再丢失边界（在途尾帧仍可入账）。
        this.#closeStreamForScene(
          info.sceneId,
          info.reason === "completed" ? "stream_completed" : "stream_cancelled",
          info.finalSequence,
        );
      },
    });
    this.#stagePort.onStageDisconnected(() => {
      this.#director.notifyStageDisconnected("control_channel_closed");
      // Stream 状态随连接丢弃：停止全部帧任务（重连后必须重新 announce）。
      // 未能送达的 closed 转入待发集合：连接恢复时冲刷（Stage 侧随控制
      // 代际失效全部媒体流，冲刷为幂等 no-op，但保持交付语义完整）。
      this.#mediaSender.cancelAll("control_channel_closed");
      this.#pendingStreams.clear();
      for (const [sceneId, record] of this.#sceneStreams) {
        this.#pendingStreamClosures.set(record.streamId, {
          sceneId,
          sessionId: this.#sessionId,
          reason: "control_channel_closed",
          ...(record.finalSequence === null ? {} : { finalSequence: record.finalSequence }),
          traceId: record.traceId,
        });
        this.#sceneStreams.delete(sceneId);
      }
    });
    options.mediaChannel?.onDisconnected(() => {
      this.#mediaSender.cancelAll("media_channel_closed");
    });
    if (!options.capabilities.audio.contentTypes.includes(PHASE_2_PCM_CONTENT_TYPE)) {
      throw new Error("stage capabilities must accept the phase 2 PCM baseline");
    }
  }

  /** 出站媒体统计（仅聚合计数，不含帧内容）。 */
  get mediaStats(): { sent: number; droppedByLimit: number; droppedByTransport: number } {
    return {
      sent: this.#mediaSender.sentTotal,
      droppedByLimit: this.#mediaSender.droppedByLimit,
      droppedByTransport: this.#mediaSender.droppedByTransport,
    };
  }

  /**
   * 提交一条 Fake Signal + Fixture：运行完整链路并返回提交结果。
   * 终态由返回的 handle.done 异步结算。
   */
  submit(input: SignalSubmission): SubmissionOutcome {
    const signalCheck = SignalSchema.safeParse(input.signal);
    if (!signalCheck.success) {
      this.#options.logger?.log("warn", "phase2_signal_invalid", {});
      return { kind: "invalid_signal" };
    }
    // 提交链 trace 根（Signal→决策→编译→DB→Control→Media 共用）：
    // Fixture 携带的根经契约 TraceIdSchema 校验（32 位小写十六进制；
    // 大写/非法形态不接受——下游审计/DB/Envelope 校验同源），否则生成
    // 新根——绝不静默换根。
    const traceId = TraceIdSchema.safeParse(input.fixture.traceId).success
      ? input.fixture.traceId
      : this.#newTraceId();
    void this.#audit(
      "phase2_signal_accepted",
      `signal:${signalCheck.data.id}`,
      {
        payloadVersion: PHASE_2_AUDIT_PAYLOAD_VERSION,
        signalId: signalCheck.data.id,
        kind: signalCheck.data.kind,
        source: signalCheck.data.source,
        cycleId: input.fixture.cycleId,
      },
      traceId,
    );
    const model = runFakeModel(input.fixture);
    if (model.rejected || model.packet === null) {
      this.#options.logger?.log("warn", "phase2_packet_rejected", {
        cycleId: input.fixture.cycleId,
      });
      void this.#audit(
        "phase2_decision_packet",
        `cycle:${input.fixture.cycleId}`,
        {
          payloadVersion: PHASE_2_AUDIT_PAYLOAD_VERSION,
          cycleId: input.fixture.cycleId,
          accepted: false,
        },
        traceId,
      );
      return { kind: "invalid_packet" };
    }
    const packet: DecisionPacket = model.packet;
    return this.submitDecision(packet, traceId);
  }

  /**
   * Phase 3 演出提交边界（phase-3-development-guide.md §9.1）：接收
   * 「已采用 DecisionPacket」，复用 Action Compiler、SpeechProvider/媒体发送器、
   * Scene Director 与 Started/Finished/Cancel 回执。Phase 2 的
   * submit(Fake Signal + Fixture) 入口保留为兼容包装，同一条内部路径。
   */
  submitDecision(packet: DecisionPacket, traceId?: string): SubmissionOutcome {
    const rootTraceId =
      traceId !== undefined && TraceIdSchema.safeParse(traceId).success
        ? traceId
        : this.#newTraceId();
    void this.#audit(
      "phase2_decision_packet",
      `cycle:${packet.cycleId}`,
      {
        payloadVersion: PHASE_2_AUDIT_PAYLOAD_VERSION,
        cycleId: packet.cycleId,
        accepted: true,
      },
      rootTraceId,
    );
    const compile: CompileResult = compileActionFrame({
      frame: packet.action,
      cycleId: packet.cycleId,
      // 编译能力以 Stage 上报快照优先（真实 Stage 声明），未上报或
      // 不含 PCM 基线时回落装配默认。
      capabilities: this.#compileCapabilities(),
      ids: this.#options.compileIds,
    });
    if (compile.kind === "noop") {
      return { kind: "noop" };
    }
    if (compile.kind === "rejected") {
      return {
        kind: "rejected",
        issues: compile.issues.map((issue: { code: string }) => ({ code: issue.code })),
      };
    }
    const sceneId = compile.plan.scene.sceneId;
    this.#stagePort.registerScene(sceneId, compile.plan.scene.cycleId, rootTraceId);
    // durable commit 与生命周期 Record 携带同一 trace 根（跨层连续）。
    this.#options.repository.bindSceneTrace?.(sceneId, rootTraceId);
    void this.#audit(
      "phase2_scene_plan_compiled",
      `scene:${sceneId}`,
      {
        payloadVersion: PHASE_2_AUDIT_PAYLOAD_VERSION,
        sceneId,
        cycleId: compile.plan.scene.cycleId,
        cueCount: compile.plan.cues.length,
        lanes: [...new Set(compile.plan.cues.map((cue) => cue.lane))],
      },
      rootTraceId,
    );
    this.#announceSpeechStream(compile.plan, rootTraceId);
    this.#activeScenes.set(sceneId, {
      cycleId: compile.plan.scene.cycleId,
      startedAt: null,
      starts: new Map(),
    });
    let handle: SceneHandle;
    try {
      handle = this.#director.submit(compile.plan, {
        sessionId: this.#sessionId,
        idempotencyKey: `phase2:${sceneId}`,
        requestFingerprint: `phase2:${packet.cycleId}:${compile.plan.cues.length}`,
      });
    } catch (error) {
      // Admission 拒绝（活跃上限/重复提交）：回滚预分配状态——announce
      // 已发出不可撤回，以 media.stream.closed 释放 Stage 槽位；异常
      // 如实上抛（不吞错、不虚报提交成功）。
      this.#activeScenes.delete(sceneId);
      this.#closeStreamForScene(sceneId, "admission_rejected");
      throw error;
    }
    void handle.done.finally(() => {
      // 终态清理：活动索引、Stream（closed 通知）与帧任务一并释放。
      this.#activeScenes.delete(sceneId);
      this.#closeStreamForScene(sceneId, "scene_terminal");
    });
    return { kind: "submitted", sceneId, handle };
  }

  /**
   * speech 存在且音频 Cue 就绪时发出 media.stream.announce（Director.submit
   * 之前）：Stage 音频 Lane 的 prepare 以预缓冲帧达标为 Ready 条件。
   */
  #announceSpeechStream(plan: ScenePlan, traceId: string): void {
    if (this.#options.mediaChannel === undefined) {
      return;
    }
    // speech 是 plan 级扩展键（Compiler 单一存放点）；弱类型读取需显式收窄。
    const speech = readPlanSpeech(plan as unknown as { speech?: unknown });
    if (speech === null) {
      return;
    }
    const audioCue = plan.cues.find((cue) => cue.lane === "audio");
    if (audioCue === undefined) {
      return;
    }
    const streamId = this.#options.recordId();
    const sent = this.#options.channel.enqueueServerMessage({
      type: "media.stream.announce",
      payload: {
        streamId,
        mediaKind: "audio",
        contentType: PHASE_2_PCM_CONTENT_TYPE,
        sceneId: plan.scene.sceneId,
        cueId: audioCue.cueId,
      },
      trace: { traceId },
    });
    if (!sent) {
      return;
    }
    this.#pendingStreams.set(streamId, {
      plan,
      speech,
      audioCueId: audioCue.cueId,
      sessionId: this.#sessionId,
      traceId,
    });
    this.#sceneStreams.set(plan.scene.sceneId, { streamId, traceId, finalSequence: null });
  }

  /**
   * 关闭 Scene 的媒体 Stream（幂等）：发送 media.stream.closed 释放
   * Stage Registry 槽位；本地帧任务与索引一并清理。finalSequence 缺省
   * 时取活跃任务当前送达边界（取消路径：已交送帧可能仍在途）。
   * 入队失败不丢事实：转入 #pendingStreamClosures，连接恢复/下次关闭
   * 时冲刷（Stage 侧控制代际失效兜底，冲刷幂等）。
   */
  #closeStreamForScene(sceneId: string, reason: string, finalSequence?: bigint): void {
    this.#flushPendingStreamClosures();
    const record = this.#sceneStreams.get(sceneId);
    if (record === undefined) {
      return;
    }
    this.#sceneStreams.delete(sceneId);
    const boundary = finalSequence ?? this.#mediaSender.finalSequenceOf(sceneId);
    this.#mediaSender.cancelStream(sceneId, reason);
    for (const [streamId, pending] of this.#pendingStreams) {
      if (pending.plan.scene.sceneId === sceneId) {
        this.#pendingStreams.delete(streamId);
      }
    }
    this.#enqueueStreamClosed(record.streamId, {
      sceneId,
      sessionId: this.#sessionId,
      reason,
      // 负边界不携带（契约 DecimalString 非负——零送达流带 "-1" 会被
      // Schema 拒绝并使 closed 永久滞留待发）。
      ...(boundary === null || boundary === undefined || boundary < 0n
        ? {}
        : { finalSequence: boundary }),
      traceId: record.traceId,
    });
  }

  /**
   * closed 入队（幂等键 = streamId）：成功即出待发集合；失败（断线/
   * 队列满）保留待发重试。
   */
  #enqueueStreamClosed(
    streamId: string,
    closure: {
      readonly sceneId: string;
      readonly sessionId: string;
      readonly reason: string;
      readonly finalSequence?: bigint;
      readonly traceId: string;
    },
  ): void {
    const sent = this.#options.channel.enqueueServerMessage({
      type: "media.stream.closed",
      payload: {
        streamId,
        reason: closure.reason,
        ...(closure.finalSequence === undefined
          ? {}
          : { finalSequence: closure.finalSequence.toString() }),
      },
      trace: { traceId: closure.traceId },
    });
    if (sent) {
      this.#pendingStreamClosures.delete(streamId);
    } else {
      this.#pendingStreamClosures.set(streamId, closure);
    }
  }

  /**
   * 冲刷未送达的 closed（连接恢复/下次关闭时机；幂等）。按 Session 过滤：
   * 归属已易主时，旧 Session 的待发项不得冲入新 Session 的连接（隔离）——
   * 其 Stage 已随控制代际失效槽位，安全丢弃。
   */
  #flushPendingStreamClosures(): void {
    for (const [streamId, closure] of this.#pendingStreamClosures) {
      if (closure.sessionId !== this.#sessionId) {
        this.#pendingStreamClosures.delete(streamId);
        continue;
      }
      this.#enqueueStreamClosed(streamId, closure);
    }
  }

  /** ControlConnection 阶段消息入口（stage.ready/started/finished/cancel.ack…）。 */
  handleStageMessage(type: string, payload: unknown, nowUs: bigint): void {
    if (type === "stage.capabilities") {
      // 能力驱动媒体预算：maxFutureUs 跟随 Stage 声明的 audio.maxBufferedUs
      // （未来音频提前量不得超过 Stage 缓冲预算）。
      this.#stagePort.handleStageMessage(type, payload, nowUs);
      const reported = this.#stagePort.latestStageCapabilities as { capabilities?: unknown } | null;
      const check = StageCapabilitiesSchema.safeParse(reported?.capabilities);
      if (check.success) {
        this.#mediaSender.updateMaxFutureUs(BigInt(check.data.audio.maxBufferedUs));
      }
      return;
    }
    if (type === "media.stream.ready") {
      const parsed = MediaStreamReadyPayloadSchema.safeParse(payload);
      if (parsed.success) {
        this.#startStream(parsed.data.streamId);
      }
      return;
    }
    if (type === "scene.started") {
      const started = payload as { sceneId?: unknown; lanes?: unknown };
      if (typeof started.sceneId === "string" && Array.isArray(started.lanes)) {
        const reports: LaneStartReport[] = [];
        for (const lane of started.lanes) {
          const entry = lane as {
            lane?: unknown;
            startedAtStageUs?: unknown;
            startedAtRuntimeUs?: unknown;
          };
          if (
            typeof entry.lane === "string" &&
            typeof entry.startedAtStageUs === "string" &&
            typeof entry.startedAtRuntimeUs === "string"
          ) {
            reports.push({
              lane: entry.lane as LaneStartReport["lane"],
              startedAtStageUs: BigInt(entry.startedAtStageUs),
              startedAtRuntimeUs: BigInt(entry.startedAtRuntimeUs),
            });
          }
        }
        const active = this.#activeScenes.get(started.sceneId);
        if (active !== undefined) {
          for (const report of reports) {
            if (!active.starts.has(report.lane))
              active.starts.set(report.lane, report.startedAtRuntimeUs);
          }
          active.startedAt ??= reports[0]?.startedAtRuntimeUs ?? null;
        }
        this.#director.notifyStarted(started.sceneId, reports);
      }
      return;
    }
    if (type === "scene.finished") {
      const finished = payload as { sceneId?: unknown; lanes?: unknown };
      if (typeof finished.sceneId === "string") {
        const active = this.#activeScenes.get(finished.sceneId);
        if (active !== undefined && active.starts.size > 1) {
          const base = [...active.starts.values()].reduce((a, b) => (a < b ? a : b));
          for (const [lane, atUs] of active.starts) {
            this.#options.metrics
              ?.histogram("bellis_scene_start_skew_ms", { lane })
              .observe(Number(atUs - base) / 1000);
          }
          active.starts.clear();
        }
      }
      if (typeof finished.sceneId === "string" && Array.isArray(finished.lanes)) {
        const reports: LaneFinishReport[] = [];
        for (const lane of finished.lanes) {
          const entry = lane as {
            lane?: unknown;
            outcome?: unknown;
            reason?: unknown;
            finishedAtStageUs?: unknown;
          };
          if (
            typeof entry.lane === "string" &&
            (entry.outcome === "completed" || entry.outcome === "failed") &&
            typeof entry.finishedAtStageUs === "string"
          ) {
            reports.push({
              lane: entry.lane as LaneFinishReport["lane"],
              outcome: entry.outcome,
              ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
              finishedAtStageUs: BigInt(entry.finishedAtStageUs),
            });
          }
        }
        const handled = this.#director.notifyFinished(finished.sceneId, reports);
        if (handled) {
          this.#activeScenes.delete(finished.sceneId);
        }
      }
      return;
    }
    this.#stagePort.handleStageMessage(type, payload, nowUs);
  }

  /** Stage 连接出现（clientType=stage 的活跃连接）。 */
  markStageConnected(sessionId?: string): void {
    if (sessionId !== undefined && sessionId !== this.#sessionId) {
      this.#sessionId = sessionId;
      this.#options.onSessionIdResolved?.(sessionId);
    }
    // 新连接可承载出站：冲刷此前未送达的 closed（幂等）。
    this.#flushPendingStreamClosures();
    this.#stagePort.markConnected();
  }

  /** 紧急打断：取消全部活动 Scene（demo 第 9 步）；取消优先于媒体发送。 */
  async interruptAll(reason: string): Promise<void> {
    for (const sceneId of Array.from(this.#activeScenes.keys())) {
      // 经 #closeStreamForScene 关闭：取消前捕获送达边界（直接
      // cancelStream 会让终态关闭取不到边界）。
      this.#closeStreamForScene(sceneId, reason);
      await this.#director.cancel(sceneId, reason);
    }
  }

  async close(): Promise<void> {
    await this.#director.close("phase2_service_close");
    this.#mediaSender.close();
    this.#activeScenes.clear();
    this.#pendingStreams.clear();
  }

  getExecutionState(sceneId: string): string | null {
    return this.#director.getExecutionState(sceneId);
  }

  /** 活动索引大小（admission 回滚的可观测账目）。 */
  get activeSceneCount(): number {
    return this.#activeScenes.size;
  }

  /**
   * 编译能力：stage.capabilities 快照为权威——Schema 校验通过即照单全收
   * （Stage 明确声明不支持 PCM 时音频 Cue 被编译拒绝 capability_missing，
   * 绝不回落默认能力重新启用 Stage 不支持的 Lane）；未上报（null）才
   * 回落装配默认。断线时快照按连接代际清除（StagePort 侧）。
   */
  #compileCapabilities(): StageCapabilities {
    const reported = this.#stagePort.latestStageCapabilities as { capabilities?: unknown } | null;
    if (reported !== null) {
      const check = StageCapabilitiesSchema.safeParse(reported.capabilities);
      if (check.success) {
        return check.data;
      }
      this.#options.logger?.log("warn", "phase2_stage_capabilities_invalid", {});
    }
    return this.#options.capabilities;
  }

  /** Snapshot v2 对账视图（§7.3/scene-execution.md §8）。 */
  activeSceneView(): {
    readonly sceneId: string;
    readonly cycleId: string;
    readonly executionState: string;
    readonly outcomeCertain: boolean;
  } | null {
    return this.#director.getActiveSceneView();
  }

  #startStream(streamId: string): void {
    const pending = this.#pendingStreams.get(streamId);
    if (pending === undefined) {
      return;
    }
    this.#pendingStreams.delete(streamId);
    this.#mediaSender.startSpeechStream({
      plan: pending.plan,
      tts: {
        frames: (signal) => {
          const provider = this.#options.speechProvider;
          if (provider === undefined) throw new Error("speech_provider_not_configured");
          return provider.stream(pending.speech, signal);
        },
      },
      audioCueId: pending.audioCueId,
      streamId,
      sessionId: pending.sessionId,
      traceId: pending.traceId,
      firstFrameTargetUs: this.#options.clock.nowUs() + this.#mediaStartLeadUs,
    });
  }

  async #audit(
    recordType: string,
    aggregateId: string,
    payload: JsonValue,
    traceId?: string,
  ): Promise<void> {
    if (this.#options.audit === undefined) {
      return;
    }
    try {
      await this.#options.audit.append({
        recordType,
        aggregateId,
        payload,
        ...(traceId === undefined ? {} : { traceId }),
      });
    } catch (error) {
      // 审计失败不阻塞提交链路，但必须显式记录（不吞错）。
      this.#options.logger?.log("warn", "phase2_audit_append_failed", {
        recordType,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  #newTraceId(): string {
    return this.#options.recordId().replaceAll("-", "").slice(0, 32);
  }
}
