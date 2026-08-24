import type { DecisionPacket, MonotonicClock, StageCapabilities } from "@bellis/contracts";
import { PHASE_2_PCM_CONTENT_TYPE, SignalSchema } from "@bellis/contracts";
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
import { ControlStagePortAdapter, type ControlChannel } from "./stage-port-adapter.js";

/**
 * Phase 2 演出应用服务（docs/phase-2-development-guide.md §9.2）。
 *
 * 编排链（新增命名服务，不扩展 Phase 1 的 FakeSceneCommitService）：
 *
 * ```text
 * validate Signal → Fake Model DecisionPacket → Action Compiler
 *   → Director（Prepare → durable commitScene+plan → Stage Commit）
 *   → 收集 started/finished（偏差指标）
 * ```
 *
 * - DecisionPacket 未经 Schema 校验通过即拒绝并记录（不进入编译）；
 * - 编译 rejected/noop 如实返回，不伪造 Scene；
 * - Stage 回执经 ControlStagePortAdapter 注入 Director 与本服务；
 * - 生命周期审计记录经 SceneRepositoryPort（append-only）。
 */

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

export class Phase2PerformanceService {
  readonly #director: SceneDirector;
  readonly #stagePort: ControlStagePortAdapter;
  readonly #options: Phase2PerformanceServiceOptions;
  readonly #activeScenes = new Map<string, { cycleId: string; startedAt: bigint | null }>();

  constructor(options: Phase2PerformanceServiceOptions) {
    this.#options = options;
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
    this.#stagePort.onStageDisconnected(() => {
      this.#director.notifyStageDisconnected("control_channel_closed");
    });
    if (!options.capabilities.audio.contentTypes.includes(PHASE_2_PCM_CONTENT_TYPE)) {
      throw new Error("stage capabilities must accept the phase 2 PCM baseline");
    }
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
    const model = runFakeModel(input.fixture);
    if (model.rejected || model.packet === null) {
      this.#options.logger?.log("warn", "phase2_packet_rejected", {
        cycleId: input.fixture.cycleId,
      });
      return { kind: "invalid_packet" };
    }
    const packet: DecisionPacket = model.packet;
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
    this.#stagePort.registerScene(compile.plan.scene.sceneId, compile.plan.scene.cycleId);
    this.#activeScenes.set(compile.plan.scene.sceneId, {
      cycleId: compile.plan.scene.cycleId,
      startedAt: null,
    });
    const handle = this.#director.submit(compile.plan, {
      sessionId: this.#options.sessionId,
      idempotencyKey: `phase2:${compile.plan.scene.sceneId}`,
      requestFingerprint: `phase2:${packet.cycleId}:${compile.plan.cues.length}`,
    });
    return { kind: "submitted", sceneId: compile.plan.scene.sceneId, handle };
  }

  /** ControlConnection 阶段消息入口（stage.ready/started/finished/cancel.ack…）。 */
  handleStageMessage(type: string, payload: unknown, nowUs: bigint): void {
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
  markStageConnected(): void {
    this.#stagePort.markConnected();
  }

  /** 紧急打断：取消全部活动 Scene（demo 第 9 步）。 */
  async interruptAll(reason: string): Promise<void> {
    for (const sceneId of Array.from(this.#activeScenes.keys())) {
      await this.#director.cancel(sceneId, reason);
    }
  }

  async close(): Promise<void> {
    await this.#director.close("phase2_service_close");
    this.#activeScenes.clear();
  }

  getExecutionState(sceneId: string): string | null {
    return this.#director.getExecutionState(sceneId);
  }
}
