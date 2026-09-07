import { StageEffectTracker } from "./effect-tracker.js";
import type { CueLane, MonotonicClock, ScenePlan } from "@bellis/contracts";
import { ScenePlanSchema } from "@bellis/contracts";
import type { ClockEstimate } from "@bellis/transport/browser";
import type { CueTimeline } from "../timeline/cue-timeline.js";
import type { LaneRegistry } from "../lanes/lane-registry.js";

/**
 * Stage Scene 客户端状态机（docs/archive/phase-2/development-guide.md §7）。
 *
 * Runtime 拥有决策权：本状态机只执行 prepare（缓冲不生效）→ ready 上报 →
 * commit（映射目标时刻并调度 Lane）→ started/finished 上报，以及 cancel →
 * 停止/释放 → ack。不改写 Scene、不补造 Cue、不自行降级硬同步组。
 *
 * - Prepare 失败的 Lane 以 unavailable + 稳定原因码上报，由 Runtime 决定；
 * - Commit 目标时刻已过（超容忍窗口）→ late_commit（scene.finished failed），
 *   绝不按过期时刻启动 hard lane；
 * - 每条 Lane 实际开始确认后单 Lane 上报 started；全部 Lane 完成后整包 finished；
 * - 连接代际变化时未 Commit 的准备缓存全部丢弃；不确定结果的 Scene 不重播。
 */

export type SceneClientState =
  | "preparing"
  | "ready"
  | "scheduled"
  | "running"
  | "finished"
  | "cancelled";

/** 场景级有界性：单连接同时最多持有的准备/执行 Scene 数。 */
const MAX_CONCURRENT_SCENES = 4;

interface PreparedScene {
  readonly plan: ScenePlan;
  state: SceneClientState;
  readonly controller: AbortController;
  scheduled: ReturnType<CueTimeline["schedule"]> | null;
  /** 逐 Lane 完成聚合（本 Scene 私有，不跨 Scene 串扰）。 */
  readonly unavailable: Map<CueLane, string>;
  readonly laneFinishes: Map<CueLane, { outcome: "completed" | "failed"; reason?: string }>;
}

/** 字幕文本发布：plan.speech 单一发言来源（Compiler 的 plan 级扩展键）。 */
export interface SpeechTextPublisher {
  setSpeechText(sceneId: string, text: string): void;
}

export interface SceneClientOptions {
  readonly sessionId?: string;
  readonly clock: MonotonicClock;
  readonly timeline: CueTimeline;
  readonly lanes: LaneRegistry;
  /** 当前连接代际的时钟估计来源（clock_ready 后非空）。 */
  readonly clockEstimate: () => ClockEstimate | null;
  /** 发送回执/报告（StageControlClient.sendClient 的封装）。 */
  readonly send: (type: string, payload: unknown) => boolean;
  readonly onEvent?: (event: {
    sceneId: string;
    state: SceneClientState;
    reason?: string;
    /** scheduled 事件：映射后的本地目标时刻（对账/偏差诊断）。 */
    targetLocalUs?: bigint;
  }) => void;
  /** plan.speech 文本 → 字幕 Lane（Prepare 阶段暂存，Commit 才可见）。 */
  readonly speechPublisher?: SpeechTextPublisher;
  /** Lane 生效时刻（started 上报时；偏差指标的浏览器侧事实来源）。 */
  readonly onLaneStarted?: (report: {
    readonly sceneId: string;
    readonly lane: string;
    readonly targetLocalUs: bigint;
    readonly startedAtStageUs: bigint;
    readonly late: boolean;
  }) => void;
  /** commit 迟到容忍（微秒，默认 20ms：来不及安全启动 hard lane 即 late）。 */
  readonly lateCommitToleranceUs?: bigint;
}

export class SceneClient {
  readonly #clock: MonotonicClock;
  readonly #timeline: CueTimeline;
  readonly #lanes: LaneRegistry;
  readonly #clockEstimate: () => ClockEstimate | null;
  readonly #send: (type: string, payload: unknown) => boolean;
  readonly #onEvent: SceneClientOptions["onEvent"];
  readonly #onLaneStarted: SceneClientOptions["onLaneStarted"];
  readonly #speechPublisher: SpeechTextPublisher | null;
  readonly #lateToleranceUs: bigint;
  readonly #scenes = new Map<string, PreparedScene>();
  readonly #effects: StageEffectTracker | null;
  readonly #effectTimer: ReturnType<typeof setInterval> | undefined;
  #connectionGeneration = 0;

  constructor(options: SceneClientOptions) {
    this.#effects =
      options.sessionId === undefined
        ? null
        : new StageEffectTracker({
            sessionId: options.sessionId,
            clock: options.clock,
            send: options.send,
          });
    if (this.#effects !== null) this.#effectTimer = setInterval(() => this.#effects?.flush(), 250);
    this.#clock = options.clock;
    this.#timeline = options.timeline;
    this.#lanes = options.lanes;
    this.#clockEstimate = options.clockEstimate;
    this.#send = options.send;
    this.#onEvent = options.onEvent;
    this.#onLaneStarted = options.onLaneStarted;
    this.#speechPublisher = options.speechPublisher ?? null;
    this.#lateToleranceUs = options.lateCommitToleranceUs ?? 20_000n;
  }

  get activeCount(): number {
    return this.#scenes.size;
  }

  /**
   * 连接代际变化：取消全部本地调度并停止已生效的 Lane 副作用（音频淡出、
   * 字幕行移除、Avatar stop）。断线后 Runtime 不再有决策通道，不能让
   * running Scene 的副作用悬空到重连；未提交的准备缓存一并丢弃，结果
   * 对账交由协议（uncertain 快照），本地绝不自行重播。
   */
  onConnectionGenerationChange(): void {
    this.#connectionGeneration++;
    this.#effects?.clear();
    for (const [sceneId, scene] of this.#scenes) {
      scene.controller.abort(new Error("connection_generation_changed"));
      scene.scheduled?.cancel();
      scene.scheduled = null;
      const reason =
        scene.state === "scheduled" || scene.state === "running"
          ? "connection_generation_changed"
          : "connection_generation_changed_prepare";
      for (const lane of new Set(scene.plan.cues.map((cue) => cue.lane))) {
        void this.#lanes
          .get(lane)
          ?.stop(sceneId, reason)
          .catch(() => {});
      }
      this.#scenes.delete(sceneId);
    }
  }

  /** scene.prepare：并行 Prepare（缓冲不生效），随后整包上报 ready。 */
  async handlePrepare(payload: unknown): Promise<void> {
    // payload 形态：{ plan: ScenePlan, prepareDeadlineUs }（scene-execution.md §3）。
    const planInput = (payload as { plan?: unknown }).plan;
    const check = ScenePlanSchema.safeParse(planInput);
    if (!check.success) {
      return; // 协议层已由 Envelope 校验兜底；此处防御反序列化异常。
    }
    const scenePlan = check.data;
    const sceneId = scenePlan.scene.sceneId;
    if (this.#scenes.has(sceneId)) {
      return; // 重复 prepare：幂等忽略。
    }
    if (this.#scenes.size >= MAX_CONCURRENT_SCENES) {
      this.#effects?.releaseUnprepared(scenePlan);
      this.#send("scene.ready", {
        sceneId,
        cycleId: scenePlan.scene.cycleId,
        lanes: [
          {
            lane: firstLane(scenePlan),
            status: "unavailable",
            reason: "stage_busy",
            cueIds: [],
          },
        ],
        preparedAtStageUs: this.#clock.nowUs().toString(),
      });
      return;
    }
    if (scenePlan.effects !== undefined) {
      const generation = this.#connectionGeneration;
      const ready = await this.#effects?.prepare(scenePlan);
      if (generation !== this.#connectionGeneration || this.#scenes.has(sceneId)) return;
      if (ready !== true) {
        this.#effects?.releaseUnprepared(scenePlan);
        this.#send("scene.ready", {
          sceneId,
          cycleId: scenePlan.scene.cycleId,
          lanes: [
            {
              lane: firstLane(scenePlan),
              status: "unavailable",
              reason: "effect_plan_unavailable",
              cueIds: [],
            },
          ],
          preparedAtStageUs: this.#clock.nowUs().toString(),
        });
        return;
      }
    }
    // plan.speech 单一发言来源 → 字幕 Lane 暂存（不可见）。
    const speech = (scenePlan as { speech?: { text?: unknown } }).speech;
    if (this.#speechPublisher !== null && typeof speech?.text === "string") {
      this.#speechPublisher.setSpeechText(sceneId, speech.text);
    }
    const scene: PreparedScene = {
      plan: scenePlan,
      state: "preparing",
      controller: new AbortController(),
      scheduled: null,
      laneFinishes: new Map(),
      unavailable: new Map(),
    };
    this.#scenes.set(sceneId, scene);
    this.#emit(sceneId, "preparing");

    const laneGroups = groupByLane(scenePlan.cues);
    const results = await Promise.all(
      [...laneGroups.entries()].map(async ([lane, cues]) => {
        const adapter = this.#lanes.get(lane);
        if (adapter === undefined) {
          scene.unavailable.set(lane, "lane_not_available");
          return { lane, status: "unavailable", reason: "lane_not_available", cueIds: [] } as const;
        }
        if (scene.controller.signal.aborted) {
          return { lane, status: "unavailable", reason: "cancelled", cueIds: [] } as const;
        }
        const laneAbort = new AbortController();
        const timer = new AbortController();
        const hard = scenePlan.scene.groups.some(
          (group) => group.level === "hard" && group.lanes.includes(lane),
        );
        const budgetMs = hard
          ? scenePlan.scene.deadlineMs
          : Math.min(scenePlan.scene.deadlineMs, scenePlan.softTimeoutMs ?? 500);
        const signal = AbortSignal.any([scene.controller.signal, laneAbort.signal]);
        // 先启动准备，零预算仍允许已就绪的 Adapter 返回结果。
        let preparing: ReturnType<typeof adapter.prepare>;
        try {
          preparing = adapter.prepare(sceneId, cues, signal);
        } catch {
          preparing = Promise.resolve({ ready: false, reason: "prepare_failed" });
        }
        const timeout = this.#clock
          .sleepUntil(this.#clock.nowUs() + BigInt(budgetMs) * 1000n, timer.signal)
          .then(
            () => ({ ready: false, reason: "prepare_timeout" }),
            () => ({ ready: false, reason: "cancelled" }),
          );
        let onAbort!: () => void;
        const cancelled = new Promise<{ ready: boolean; reason: string }>((resolve) => {
          onAbort = () => resolve({ ready: false, reason: "cancelled" });
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
        const outcome = await Promise.race([preparing, timeout, cancelled]).catch(() => ({
          ready: false,
          reason: "prepare_failed",
        }));
        signal.removeEventListener("abort", onAbort);
        timer.abort();
        if (!outcome.ready) {
          scene.unavailable.set(lane, outcome.reason ?? "unavailable");
          laneAbort.abort();
          void adapter.stop(sceneId, "prepare_unavailable").catch(() => undefined);
        }
        return {
          lane,
          status: outcome.ready ? ("ready" as const) : ("unavailable" as const),
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
          cueIds: cues.map((cue) => cue.cueId),
        };
      }),
    );
    if (scene.controller.signal.aborted) {
      this.#scenes.delete(sceneId);
      return;
    }
    scene.state = "ready";
    this.#emit(sceneId, "ready");
    this.#send("scene.ready", {
      sceneId,
      cycleId: scenePlan.scene.cycleId,
      lanes: results,
      preparedAtStageUs: this.#clock.nowUs().toString(),
    });
  }

  /** scene.commit：映射目标时刻并调度；过晚则 late_commit。 */
  handleCommit(sceneId: string, commitAtRuntimeUs: bigint): void {
    const scene = this.#scenes.get(sceneId);
    if (scene === undefined || scene.state !== "ready") {
      // 未 prepare / 已终态的 commit 属于协议违例或旧代际消息：本地拒绝，
      // 不伪造 cycleId 上报（§7.3「旧连接 generation 的 Commit 全部拒绝」）。
      this.#emit(sceneId, "cancelled", "unknown_scene_commit_ignored");
      return;
    }
    const estimate = this.#clockEstimate();
    if (estimate === null) {
      scene.state = "finished";
      this.#finish(scene, allLanesFailed(scene.plan, "clock_not_ready"));
      return;
    }
    const targetLocalUs = this.#timeline.mapRuntimeToLocal(commitAtRuntimeUs, estimate);
    if (targetLocalUs < this.#clock.nowUs() - this.#lateToleranceUs) {
      scene.state = "finished";
      this.#finish(scene, allLanesFailed(scene.plan, "late_commit"));
      return;
    }
    const laneGroups = groupByLane(scene.plan.cues);
    const criticalLanes = new Set(
      scene.plan.scene.groups
        .filter((group) => group.level === "hard")
        .flatMap((group) => group.lanes),
    );
    this.#effects?.commit(sceneId);
    scene.scheduled = this.#timeline.schedule(
      sceneId,
      targetLocalUs,
      [...laneGroups.keys()].map((lane) => ({
        lane,
        critical: criticalLanes.has(lane),
        onDropped: () => this.#laneFinished(scene, lane, "failed", "late_dropped"),
        fire: ({ late }: { late: boolean }) => {
          if (scene.controller.signal.aborted) return;
          const unavailable = scene.unavailable.get(lane);
          if (unavailable !== undefined) {
            this.#laneFinished(scene, lane, "failed", unavailable);
            return;
          }
          let reported = false;
          const onStarted = (confirmedAtUs?: bigint) => {
            if (reported || scene.controller.signal.aborted || !this.#scenes.has(sceneId)) return;
            reported = true;
            const startedAtStageUs = confirmedAtUs ?? this.#clock.nowUs();
            this.#onLaneStarted?.({
              sceneId,
              lane,
              targetLocalUs,
              startedAtStageUs,
              late,
            });
            this.#send("scene.started", {
              sceneId,
              cycleId: scene.plan.scene.cycleId,
              lanes: [
                {
                  lane,
                  startedAtStageUs: startedAtStageUs.toString(),
                  startedAtRuntimeUs: (startedAtStageUs + estimate.runtimeOffsetUs).toString(),
                },
              ],
            });
          };
          if (scene.state === "scheduled") {
            scene.state = "running";
            this.#emit(sceneId, "running");
          }
          const adapter = this.#lanes.get(lane);
          if (adapter === undefined) {
            this.#laneFinished(scene, lane, "failed", "lane_not_available");
            return;
          }
          if (late) {
            // 迟到的 hard lane 不补播（§7.2），以 late_commit 失败上报。
            this.#laneFinished(scene, lane, "failed", "late_commit");
            return;
          }
          void adapter
            .start(sceneId, targetLocalUs, laneGroups.get(lane) ?? [], onStarted)
            .then(() => this.#laneFinished(scene, lane, "completed"))
            .catch(() => this.#laneFinished(scene, lane, "failed", "lane_error"));
        },
      })),
    );
    scene.state = "scheduled";
    this.#emit(sceneId, "scheduled", undefined, targetLocalUs);
  }

  /** scene.cancel：取消调度并停止/释放全部 Lane，随后 ack。 */
  async handleCancel(sceneId: string, reason: string): Promise<void> {
    const scene = this.#scenes.get(sceneId);
    if (scene === undefined) {
      // 未知 Scene 的取消：本地拒绝（无法填写真实 cycleId，不伪造回执）。
      this.#emit(sceneId, "cancelled", "unknown_scene_cancel_ignored");
      return;
    }
    scene.controller.abort(new Error(reason));
    scene.scheduled?.cancel();
    scene.scheduled = null;
    const lanes = [...new Set(scene.plan.cues.map((cue) => cue.lane))];
    const results = await Promise.all(
      lanes.map(async (lane) => {
        const adapter = this.#lanes.get(lane);
        if (adapter === undefined) {
          return { lane, stopped: true };
        }
        const stopped = await adapter
          .stop(sceneId, reason)
          .then(() => true)
          .catch(() => false);
        return stopped ? { lane, stopped: true } : { lane, stopped: false, reason: "lane_error" };
      }),
    );
    this.#scenes.delete(sceneId);
    this.#effects?.finish(sceneId);
    this.#emit(sceneId, "cancelled", reason);
    this.#send("scene.cancel.ack", {
      sceneId,
      cycleId: scene.plan.scene.cycleId,
      lanes: results,
      stoppedAtStageUs: this.#clock.nowUs().toString(),
    });
  }

  /** 关闭：取消全部调度并释放（页面关闭/StageApp close）。 */
  sealEffects(payload: unknown): void {
    this.#effects?.seal(payload);
  }
  releaseEffect(payload: unknown): void {
    this.#effects?.released(payload);
  }
  bindAudioEffect(payload: unknown): void {
    this.#effects?.bindAudio(payload);
  }
  acknowledgeEffect(payload: unknown): void {
    this.#effects?.acknowledge(payload);
  }
  audioRendered(sceneId: string, samples: number, atUs: bigint): void {
    this.#effects?.audioRendered(sceneId, samples, atUs);
  }
  subtitleApplied(sceneId: string, start: number, end: number, atUs: bigint): void {
    this.#effects?.subtitleApplied(sceneId, start, end, atUs);
  }

  close(): void {
    this.#connectionGeneration++;
    clearInterval(this.#effectTimer);
    this.#effects?.clear();
    for (const scene of this.#scenes.values()) {
      scene.controller.abort(new Error("stage_closing"));
      scene.scheduled?.cancel();
      scene.scheduled = null;
    }
    this.#scenes.clear();
  }

  #laneFinished(
    scene: PreparedScene,
    lane: CueLane,
    outcome: "completed" | "failed",
    reason?: string,
  ): void {
    if (scene.controller.signal.aborted || !this.#scenes.has(scene.plan.scene.sceneId)) {
      return; // 已取消/终态：迟到完成不改写结果。
    }
    scene.laneFinishes.set(lane, { outcome, ...(reason === undefined ? {} : { reason }) });
    const allLanes = [...new Set(scene.plan.cues.map((cue) => cue.lane))];
    if (!allLanes.every((l) => scene.laneFinishes.has(l))) {
      return;
    }
    const results = allLanes.map((l) => {
      const record = scene.laneFinishes.get(l) ?? { outcome: "completed" as const };
      return {
        lane: l,
        outcome: record.outcome,
        ...(record.reason === undefined ? {} : { reason: record.reason }),
      };
    });
    scene.state = "finished";
    this.#finish(scene, results);
  }

  #finish(
    scene: PreparedScene,
    lanes: readonly { lane: CueLane; outcome: "completed" | "failed"; reason?: string }[],
  ): void {
    const sceneId = scene.plan.scene.sceneId;
    this.#scenes.delete(sceneId);
    this.#effects?.finish(sceneId);
    this.#emit(sceneId, "finished");
    this.#send("scene.finished", {
      sceneId,
      cycleId: scene.plan.scene.cycleId,
      lanes: lanes.map((lane) => ({
        lane: lane.lane,
        outcome: lane.outcome,
        ...(lane.reason === undefined ? {} : { reason: lane.reason }),
        finishedAtStageUs: this.#clock.nowUs().toString(),
      })),
    });
    void Promise.all(
      [...new Set(scene.plan.cues.map((cue) => cue.lane))].map((lane) =>
        this.#lanes
          .get(lane)
          ?.finish(sceneId)
          .catch(() => {}),
      ),
    );
  }

  #emit(sceneId: string, state: SceneClientState, reason?: string, targetLocalUs?: bigint): void {
    this.#onEvent?.({
      sceneId,
      state,
      ...(reason === undefined ? {} : { reason }),
      ...(targetLocalUs === undefined ? {} : { targetLocalUs }),
    });
  }
}

function groupByLane(cues: readonly ScenePlan["cues"][number][]): Map<CueLane, ScenePlan["cues"]> {
  const groups = new Map<CueLane, ScenePlan["cues"]>();
  for (const cue of cues) {
    const list = groups.get(cue.lane) ?? [];
    list.push(cue);
    groups.set(cue.lane, list);
  }
  return groups;
}

function firstLane(plan: ScenePlan): CueLane {
  return plan.cues[0]?.lane ?? "audio";
}

function allLanesFailed(plan: ScenePlan, reason: string) {
  return [...new Set(plan.cues.map((cue) => cue.lane))].map((lane) => ({
    lane,
    outcome: "failed" as const,
    reason,
  }));
}
