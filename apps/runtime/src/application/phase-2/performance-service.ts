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
  PHASE_2_PCM_CONTENT_TYPE,
  SignalSchema,
  SpeechIntentSchema,
} from "@bellis/contracts";
import type { LoggerPort, MetricsPort } from "@bellis/observability";
import {
  SceneDirector,
  compileActionFrame,
  type CompileIdSource,
  type CompileResult,
  type DirectorPolicy,
  type LaneFinishReport,
  type LaneStartReport,
  type SceneHandle,
  type SceneRepositoryPort,
} from "@bellis/scene-runtime";
import { runFakeModel, type FakeModelFixture } from "./fake-model.js";
import { synthesizeSpeech, type FakeTtsResult } from "./fake-tts.js";
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
  }): Promise<void>;
}

/** 出站流首帧目标提前量：须 ≤ Director commitLeadMs（提前缓冲，不超前播放）。 */
const DEFAULT_MEDIA_START_LEAD_US = 150_000n;

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
  /** 媒体出站通道（缺省不编排 PCM 流，纯 Control 链路仍可用）。 */
  readonly mediaChannel?: MediaOutboundChannel;
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
  readonly tts: FakeTtsResult;
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
  readonly #activeScenes = new Map<string, { cycleId: string; startedAt: bigint | null }>();
  /** 已 announce、等待 media.stream.ready 的流（≤ 活跃 Scene 上限，有界）。 */
  readonly #pendingStreams = new Map<string, PendingStream>();

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
    });
    this.#mediaSender = new RuntimeMediaSender({
      clock: options.clock,
      sendFrame: (frame) => options.mediaChannel?.sendFrame(frame) ?? false,
    });
    this.#stagePort.onStageDisconnected(() => {
      this.#director.notifyStageDisconnected("control_channel_closed");
      // Stream 状态随连接丢弃：停止全部帧任务（重连后必须重新 announce）。
      this.#mediaSender.cancelAll("control_channel_closed");
      this.#pendingStreams.clear();
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
    void this.#audit("phase2_signal_accepted", `signal:${signalCheck.data.id}`, {
      signalId: signalCheck.data.id,
      kind: signalCheck.data.kind,
      source: signalCheck.data.source,
      cycleId: input.fixture.cycleId,
    });
    const model = runFakeModel(input.fixture);
    if (model.rejected || model.packet === null) {
      this.#options.logger?.log("warn", "phase2_packet_rejected", {
        cycleId: input.fixture.cycleId,
      });
      void this.#audit("phase2_decision_packet", `cycle:${input.fixture.cycleId}`, {
        cycleId: input.fixture.cycleId,
        accepted: false,
      });
      return { kind: "invalid_packet" };
    }
    const packet: DecisionPacket = model.packet;
    void this.#audit("phase2_decision_packet", `cycle:${packet.cycleId}`, {
      cycleId: packet.cycleId,
      accepted: true,
    });
    const compile: CompileResult = compileActionFrame({
      frame: packet.action,
      cycleId: packet.cycleId,
      capabilities: this.#options.capabilities,
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
    const traceId = this.#newTraceId();
    this.#stagePort.registerScene(sceneId, compile.plan.scene.cycleId, traceId);
    void this.#audit("phase2_scene_plan_compiled", `scene:${sceneId}`, {
      sceneId,
      cycleId: compile.plan.scene.cycleId,
      cueCount: compile.plan.cues.length,
      lanes: [...new Set(compile.plan.cues.map((cue) => cue.lane))],
    });
    this.#announceSpeechStream(compile.plan, traceId);
    this.#activeScenes.set(sceneId, {
      cycleId: compile.plan.scene.cycleId,
      startedAt: null,
    });
    const handle = this.#director.submit(compile.plan, {
      sessionId: this.#sessionId,
      idempotencyKey: `phase2:${sceneId}`,
      requestFingerprint: `phase2:${packet.cycleId}:${compile.plan.cues.length}`,
    });
    void handle.done.finally(() => {
      // 终态清理：活动索引、未确认流与帧任务一并释放（有界状态）。
      this.#activeScenes.delete(sceneId);
      this.#mediaSender.cancelStream(sceneId, "scene_terminal");
      for (const [streamId, pending] of this.#pendingStreams) {
        if (pending.plan.scene.sceneId === sceneId) {
          this.#pendingStreams.delete(streamId);
        }
      }
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
      tts: synthesizeSpeech(speech),
      audioCueId: audioCue.cueId,
      sessionId: this.#sessionId,
      traceId,
    });
  }

  /** ControlConnection 阶段消息入口（stage.ready/started/finished/cancel.ack…）。 */
  handleStageMessage(type: string, payload: unknown, nowUs: bigint): void {
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
        if (active !== undefined && active.startedAt === null && reports.length > 0) {
          active.startedAt = reports[0]!.startedAtRuntimeUs;
          // 起始偏差指标（同一 Scene 内各 Lane 相对首 Lane）。
          const base = reports[0]!.startedAtRuntimeUs;
          for (const report of reports) {
            const skewUs = report.startedAtRuntimeUs - base;
            this.#options.metrics
              ?.histogram("bellis_scene_start_skew_ms", { lane: report.lane })
              .observe(Number(skewUs / 1000n));
          }
        }
        this.#director.notifyStarted(started.sceneId, reports);
      }
      return;
    }
    if (type === "scene.finished") {
      const finished = payload as { sceneId?: unknown; lanes?: unknown };
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
    this.#stagePort.markConnected();
  }

  /** 紧急打断：取消全部活动 Scene（demo 第 9 步）；取消优先于媒体发送。 */
  async interruptAll(reason: string): Promise<void> {
    for (const sceneId of Array.from(this.#activeScenes.keys())) {
      this.#mediaSender.cancelStream(sceneId, reason);
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

  #startStream(streamId: string): void {
    const pending = this.#pendingStreams.get(streamId);
    if (pending === undefined) {
      return;
    }
    this.#pendingStreams.delete(streamId);
    this.#mediaSender.startSpeechStream({
      plan: pending.plan,
      tts: pending.tts,
      audioCueId: pending.audioCueId,
      streamId,
      sessionId: pending.sessionId,
      traceId: pending.traceId,
      firstFrameTargetUs: this.#options.clock.nowUs() + this.#mediaStartLeadUs,
    });
  }

  async #audit(recordType: string, aggregateId: string, payload: JsonValue): Promise<void> {
    if (this.#options.audit === undefined) {
      return;
    }
    try {
      await this.#options.audit.append({ recordType, aggregateId, payload });
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
