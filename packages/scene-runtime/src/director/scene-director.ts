import type { MonotonicClock, SceneExecutionState, ScenePlan, SyncGroup } from "@bellis/contracts";
import type { LoggerPort, MetricsPort } from "@bellis/observability";
import { createNoopLogger, createNoopMetrics } from "@bellis/observability";
import { validateScenePlan } from "../compiler/plan-validator.js";
import { PrepareBarrier } from "./barrier.js";
import {
  DurableCommitError,
  StageCommitAmbiguousError,
  type CancelOutcome,
  type SceneLifecycleRecord,
  type SceneRepositoryPort,
  type StageLaneReady,
  type StagePort,
  type StageReady,
} from "./ports.js";

/**
 * Scene Director（docs/phase-2-development-guide.md §6.2）。
 *
 * 状态机（内部）：
 *
 * ```text
 * created → preparing → ready → committing → scheduled → running → completed
 * 任意活跃态 → cancelling → cancelled
 * 任意活跃态 → failed
 * 结果无法证明 → uncertain（终态，恢复对账后不再自动执行）
 * ```
 *
 * 关键不变量：
 * - 每个 Scene 一个根 AbortController；cancel/关闭经 abort 向下传播。
 * - `commitAtRuntimeUs` 在 durable 提交**之前**选定（now + lead），数据库
 *   原子提交成功之后才发送 stage.commit；数据库失败时 Stage 只会收到
 *   取消/释放，绝不收到 Commit。
 * - durable 成功但 stage.commit 结果不确定（StageCommitAmbiguousError）
 *   → uncertain，绝不自动重试外部效果。
 * - 同一 Scene 的状态转换串行化（每 Scene 一个操作链）；迟到
 *   started/finished 回执不得复活终态。
 * - 公开执行状态（SceneExecutionState）不含内部过渡态 created/
 *   committing/cancelling：快照/查询按映射收敛。
 */

/** 内部完整状态（生命周期 Record 记录确切转换；公开状态是其投影）。 */
export type DirectorInternalState =
  | "created"
  | "preparing"
  | "ready"
  | "committing"
  | "scheduled"
  | "running"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed"
  | "uncertain";

const TERMINAL_STATES: ReadonlySet<DirectorInternalState> = new Set([
  "completed",
  "cancelled",
  "failed",
  "uncertain",
]);

/** 内部状态 → 公开 SceneExecutionState 的投影。 */
function publicState(state: DirectorInternalState): SceneExecutionState {
  switch (state) {
    case "created":
    case "preparing":
    case "cancelling":
      return "preparing";
    case "ready":
    case "committing":
      return "ready";
    case "scheduled":
      return "scheduled";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "uncertain":
      return "uncertain";
  }
}

export interface DirectorPolicy {
  /** commitAtRuntimeUs 的提前量（毫秒）：now + lead，足够 Stage 映射与预缓冲。 */
  readonly commitLeadMs: number;
  /** stage.prepare 的整体预算之外的单次 cancel 调用超时（毫秒）。 */
  readonly cancelTimeoutMs: number;
  /** 单次 stage.commit 发送超时（毫秒）；超时归类为结果不确定。 */
  readonly commitSendTimeoutMs: number;
  /** 并发活跃 Scene 上限（有界）。 */
  readonly maxActiveScenes: number;
  /** close() 排空全部活跃 Scene 的总预算（毫秒）。 */
  readonly closeTimeoutMs: number;
}

export const DEFAULT_DIRECTOR_POLICY: DirectorPolicy = {
  commitLeadMs: 400,
  cancelTimeoutMs: 1000,
  commitSendTimeoutMs: 1000,
  maxActiveScenes: 16,
  closeTimeoutMs: 5000,
};

export interface SceneDirectorOptions {
  readonly stage: StagePort;
  readonly repository: SceneRepositoryPort;
  readonly clock: MonotonicClock;
  /** 审计墙钟（毫秒）；显式注入，Director 不读取 Date.now。 */
  readonly wallClockMs: () => number;
  readonly logger?: LoggerPort;
  readonly metrics?: MetricsPort;
  readonly policy?: Partial<DirectorPolicy>;
}

export interface SubmitOptions {
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface SceneOutcome {
  readonly sceneId: string;
  readonly state: SceneExecutionState;
  readonly reason?: string;
}

export interface SceneHandle {
  readonly sceneId: string;
  /** 终态（completed/cancelled/failed/uncertain）时 resolve。 */
  readonly done: Promise<SceneOutcome>;
  /** 请求取消；终态 Scene 幂等无操作。返回当前公开状态。 */
  cancel(reason: string): Promise<SceneExecutionState | null>;
}

/** started/finished 回执的领域形态（时间已转 bigint）。 */
export interface LaneStartReport {
  readonly lane: StageLaneReady["lane"];
  readonly startedAtStageUs: bigint;
  readonly startedAtRuntimeUs: bigint;
}

export interface LaneFinishReport {
  readonly lane: StageLaneReady["lane"];
  readonly outcome: "completed" | "failed";
  readonly reason?: string;
  readonly finishedAtStageUs: bigint;
}

class PrepareDeadlineError extends Error {
  constructor() {
    super("prepare deadline exceeded");
    this.name = "PrepareDeadlineError";
  }
}

class SceneAbortedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SceneAbortedError";
  }
}

interface SceneExecution {
  readonly plan: ScenePlan;
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly controller: AbortController;
  readonly laneLevels: ReadonlyMap<string, "hard" | "soft" | "detached">;
  state: DirectorInternalState;
  cancelRequested: boolean;
  cancelReason: string | null;
  startedReported: boolean;
  /** #awaitTerminal 建立的终态解除回调（finished/disconnect 时调用）。 */
  resolveTerminalWait: (() => void) | null;
  resolveDone: (outcome: SceneOutcome) => void;
}

/** 用时钟构造一次性超时信号；dispose 取消底层等待，无残留定时器。 */
function timeoutSignal(
  clock: MonotonicClock,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = new AbortController();
  void clock.sleepUntil(clock.nowUs() + BigInt(timeoutMs) * 1000n, timer.signal).then(
    () => {
      controller.abort(new Error("timeout"));
    },
    () => {},
  );
  return {
    signal: controller.signal,
    dispose: () => {
      timer.abort(new Error("disposed"));
    },
  };
}

function laneLevelMap(groups: readonly SyncGroup[]): Map<string, "hard" | "soft" | "detached"> {
  const map = new Map<string, "hard" | "soft" | "detached">();
  for (const group of groups) {
    for (const lane of group.lanes) {
      map.set(lane, group.level);
    }
  }
  return map;
}

export class SceneDirector {
  readonly #stage: StagePort;
  readonly #repository: SceneRepositoryPort;
  readonly #clock: MonotonicClock;
  readonly #wallClockMs: () => number;
  readonly #logger: LoggerPort;
  readonly #metrics: MetricsPort;
  readonly #policy: DirectorPolicy;
  readonly #executions = new Map<string, SceneExecution>();
  #closed = false;
  #closeWaiters: (() => void)[] = [];

  constructor(options: SceneDirectorOptions) {
    this.#stage = options.stage;
    this.#repository = options.repository;
    this.#clock = options.clock;
    this.#wallClockMs = options.wallClockMs;
    this.#logger = options.logger ?? createNoopLogger();
    this.#metrics = options.metrics ?? createNoopMetrics();
    this.#policy = { ...DEFAULT_DIRECTOR_POLICY, ...options.policy };
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** 活跃（未终态）Scene 数，用于有界性断言。 */
  get activeCount(): number {
    let count = 0;
    for (const exec of this.#executions.values()) {
      if (!TERMINAL_STATES.has(exec.state)) {
        count += 1;
      }
    }
    return count;
  }

  /** 公开执行状态投影；未知 Scene 返回 null。 */
  getExecutionState(sceneId: string): SceneExecutionState | null {
    const exec = this.#executions.get(sceneId);
    return exec === undefined ? null : publicState(exec.state);
  }

  /**
   * 提交一个已编译的 ScenePlan 并驱动到终态。plan 先经结构校验；
   * Director 关闭后拒绝新提交。
   */
  submit(plan: unknown, options: SubmitOptions): SceneHandle {
    if (this.#closed) {
      throw new Error("scene_director_closed");
    }
    const validation = validateScenePlan(plan);
    if (!validation.ok) {
      throw new Error(`scene plan rejected: ${validation.issues.map((i) => i.code).join(",")}`);
    }
    if (this.activeCount >= this.#policy.maxActiveScenes) {
      throw new Error("scene_director_active_limit_reached");
    }
    const scenePlan = validation.plan;
    if (this.#executions.has(scenePlan.scene.sceneId)) {
      throw new Error(`scene ${scenePlan.scene.sceneId} already submitted`);
    }

    let resolveDone!: (outcome: SceneOutcome) => void;
    const done = new Promise<SceneOutcome>((resolve) => {
      resolveDone = resolve;
    });
    const exec: SceneExecution = {
      plan: scenePlan,
      sessionId: options.sessionId,
      idempotencyKey: options.idempotencyKey,
      requestFingerprint: options.requestFingerprint,
      controller: new AbortController(),
      laneLevels: laneLevelMap(scenePlan.scene.groups),
      state: "created",
      cancelRequested: false,
      cancelReason: null,
      startedReported: false,
      resolveTerminalWait: null,
      resolveDone,
    };
    this.#executions.set(scenePlan.scene.sceneId, exec);
    void this.#run(exec);
    return {
      sceneId: scenePlan.scene.sceneId,
      done,
      cancel: (reason: string) => this.cancel(scenePlan.scene.sceneId, reason),
    };
  }

  /** Stage 回报实际起始（scene.started）；迟到回执在终态被忽略。 */
  notifyStarted(sceneId: string, lanes: readonly LaneStartReport[]): boolean {
    const exec = this.#executions.get(sceneId);
    if (exec === undefined || TERMINAL_STATES.has(exec.state)) {
      return false;
    }
    if (exec.state === "scheduled") {
      this.#transition(exec, "running", "stage_started");
    }
    exec.startedReported = true;
    this.#logger.log("debug", "scene_lane_started", {
      sceneId,
      lanes: lanes.map((lane) => lane.lane).join(","),
    });
    return true;
  }

  /** Stage 回报逐 Lane 结果（scene.finished）；聚合为 completed/failed。 */
  notifyFinished(sceneId: string, lanes: readonly LaneFinishReport[]): boolean {
    const exec = this.#executions.get(sceneId);
    if (exec === undefined || TERMINAL_STATES.has(exec.state)) {
      return false;
    }
    if (exec.cancelRequested) {
      // 取消已请求：取消路径拥有终态归属，迟到 finished 不复活/改写结果。
      return false;
    }
    const failedHard = lanes.filter(
      (lane) => lane.outcome === "failed" && exec.laneLevels.get(lane.lane) === "hard",
    );
    const failedSoft = lanes.filter(
      (lane) => lane.outcome === "failed" && exec.laneLevels.get(lane.lane) !== "hard",
    );
    if (failedHard.length > 0) {
      this.#transition(exec, "failed", `lane_failed:${failedHard.map((l) => l.lane).join(",")}`);
      this.#finish(exec, "failed", `lane_failed:${failedHard.map((l) => l.lane).join(",")}`);
    } else {
      const note =
        failedSoft.length > 0
          ? `soft_lane_absent:${failedSoft.map((l) => l.lane).join(",")}`
          : undefined;
      this.#transition(exec, "completed", "stage_finished", note);
      this.#finish(exec, "completed", note);
    }
    return true;
  }

  /**
   * Stage 连接断开：准备中 → cancelled（Stage 侧资源随连接释放）；
   * durable 之后（committing 未确认 / scheduled / running）→ uncertain。
   */
  notifyStageDisconnected(reason: string): void {
    for (const exec of this.#executions.values()) {
      if (TERMINAL_STATES.has(exec.state)) {
        continue;
      }
      exec.controller.abort(new SceneAbortedError(`stage_disconnected:${reason}`));
      switch (exec.state) {
        case "created":
        case "preparing":
        case "ready":
          this.#transition(exec, "cancelled", `stage_disconnected:${reason}`);
          this.#finish(exec, "cancelled", `stage_disconnected:${reason}`);
          break;
        case "committing":
        case "scheduled":
        case "running":
        case "cancelling":
          this.#transition(exec, "uncertain", `stage_disconnected:${reason}`);
          this.#finish(exec, "uncertain", `stage_disconnected:${reason}`);
          break;
      }
    }
    this.#wakeCloseWaiters();
  }

  /** 请求取消；终态 Scene 幂等无操作。 */
  async cancel(sceneId: string, reason: string): Promise<SceneExecutionState | null> {
    const exec = this.#executions.get(sceneId);
    if (exec === undefined) {
      return null;
    }
    if (TERMINAL_STATES.has(exec.state)) {
      return publicState(exec.state);
    }
    exec.cancelRequested = true;
    exec.cancelReason = reason;
    if (exec.state !== "cancelling") {
      this.#transition(exec, "cancelling", reason);
    }
    exec.controller.abort(new SceneAbortedError(reason));
    return publicState(exec.state);
  }

  /**
   * 关闭：停止接受新 Scene，取消全部活跃 Scene 并等待终态（总预算
   * closeTimeoutMs）；超时后剩余 Scene 标记 failed:shutdown_timeout。
   */
  async close(reason = "director_shutdown"): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const active = [...this.#executions.values()].filter(
      (exec) => !TERMINAL_STATES.has(exec.state),
    );
    for (const exec of active) {
      exec.cancelRequested = true;
      exec.cancelReason = reason;
      if (exec.state !== "cancelling") {
        this.#transition(exec, "cancelling", reason);
      }
      exec.controller.abort(new SceneAbortedError(reason));
    }
    if (active.length === 0) {
      return;
    }
    const deadlineUs = this.#clock.nowUs() + BigInt(this.#policy.closeTimeoutMs) * 1000n;
    // 预算与排空竞速：全部 Scene 提前到终态时立即返回，不空等。
    await Promise.race([
      this.#clock.sleepUntil(deadlineUs).catch(() => {}),
      new Promise<void>((resolve) => {
        this.#closeWaiters.push(resolve);
        // 入队后复检：竞态下可能已排空（waiter 入队晚于最后一次唤醒）。
        this.#wakeCloseWaiters();
      }),
    ]);
    for (const exec of active) {
      if (!TERMINAL_STATES.has(exec.state)) {
        this.#transition(exec, "failed", `${reason}:timeout`);
        this.#finish(exec, "failed", `${reason}:timeout`);
      }
    }
    this.#wakeCloseWaiters();
  }

  /** 等待全部活跃 Scene 到终态（close 之后用于排空确认）。 */
  async drained(): Promise<void> {
    if (this.activeCount === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.#closeWaiters.push(resolve);
    });
  }

  #wakeCloseWaiters(): void {
    if (this.activeCount === 0) {
      const waiters = this.#closeWaiters;
      this.#closeWaiters = [];
      for (const resolve of waiters) {
        resolve();
      }
    }
  }

  async #run(exec: SceneExecution): Promise<void> {
    const sceneId = exec.plan.scene.sceneId;
    try {
      this.#transition(exec, "preparing", "submitted");
      const prepareStartUs = this.#clock.nowUs();
      const deadlineUs = prepareStartUs + BigInt(exec.plan.scene.deadlineMs) * 1000n;

      const stageReady = await this.#prepareWithDeadline(exec, deadlineUs);
      const preparedUs = this.#clock.nowUs();
      this.#metrics
        .histogram("bellis_scene_prepare_duration_ms", { result: "ready" })
        .observe(Number((preparedUs - prepareStartUs) / 1000n));

      const barrier = new PrepareBarrier({
        groups: exec.plan.scene.groups,
        softTimeoutUs: BigInt(500) * 1000n,
      });
      const barrierStartUs = preparedUs;
      for (const lane of stageReady.lanes) {
        barrier.reportLane(lane);
      }
      const verdict = barrier.judge(this.#clock.nowUs(), barrierStartUs, { force: true });
      if (verdict.verdict === "hard_unavailable") {
        const detail = [
          ...verdict.lanes.map((lane) => `${lane.lane}:${lane.reason ?? "unavailable"}`),
          ...verdict.missingHardLanes.map((lane) => `${lane}:missing`),
        ].join(",");
        this.#metrics
          .histogram("bellis_scene_barrier_wait_ms", { level: "hard", result: "unavailable" })
          .observe(Number((this.#clock.nowUs() - barrierStartUs) / 1000n));
        await this.#cancelViaStage(exec, `hard_lane_unavailable:${detail}`);
        return;
      }
      this.#metrics
        .histogram("bellis_scene_barrier_wait_ms", { level: "hard", result: "ready" })
        .observe(Number((this.#clock.nowUs() - barrierStartUs) / 1000n));
      if (verdict.verdict === "ready" && verdict.absentLanes.length > 0) {
        this.#logger.log("info", "scene_soft_lane_absent", {
          sceneId,
          lanes: verdict.absentLanes.join(","),
        });
      }

      this.#transition(exec, "ready", "barrier_ready");
      if (exec.cancelRequested) {
        await this.#cancelViaStage(exec, exec.cancelReason ?? "cancelled_before_commit");
        return;
      }

      // commitAtRuntimeUs 先于 durable 提交选定（§6.2）。
      const commitAtRuntimeUs = this.#clock.nowUs() + BigInt(this.#policy.commitLeadMs) * 1000n;
      this.#transition(exec, "committing", "commit_selected");

      let durable;
      try {
        durable = await this.#repository.commit(
          {
            sessionId: exec.sessionId,
            plan: exec.plan,
            idempotencyKey: exec.idempotencyKey,
            requestFingerprint: exec.requestFingerprint,
          },
          exec.controller.signal,
        );
      } catch (error) {
        // 数据库失败：Stage 只收到取消/释放，绝不收到 Commit。
        const code = error instanceof DurableCommitError ? error.code : "durable_commit_failed";
        await this.#releaseStageQuietly(exec, `durable_commit_failed:${code}`);
        this.#transition(exec, "failed", `durable_commit_failed:${code}`);
        this.#finish(exec, "failed", `durable_commit_failed:${code}`);
        return;
      }
      this.#logger.log("info", "scene_durable_committed", {
        sceneId,
        cycleId: exec.plan.scene.cycleId,
        committedAtMs: durable.committedAtMs,
        duplicate: durable.duplicate,
      });
      if (exec.cancelRequested) {
        await this.#cancelViaStage(exec, exec.cancelReason ?? "cancelled_after_durable");
        return;
      }

      try {
        await this.#commitToStage(exec, commitAtRuntimeUs);
      } catch (error) {
        if (error instanceof StageCommitAmbiguousError) {
          this.#transition(exec, "uncertain", "stage_commit_ambiguous");
          this.#finish(exec, "uncertain", "stage_commit_ambiguous");
        } else {
          await this.#releaseStageQuietly(exec, "stage_commit_failed");
          this.#transition(exec, "failed", "stage_commit_failed");
          this.#finish(exec, "failed", "stage_commit_failed");
        }
        return;
      }
      this.#transition(exec, "scheduled", "stage_commit_sent");
      if (exec.startedReported) {
        // started 回执先于 commit ack 到达（适配器语义差异）：立即转 running。
        this.#transition(exec, "running", "stage_started_late_ack");
      }
      this.#logger.log("info", "scene_scheduled", {
        sceneId,
        commitAtRuntimeUs: commitAtRuntimeUs.toString(),
      });

      // 等待 started/finished 或取消（abort 拒绝走 catch）。
      await this.#awaitTerminal(exec);
    } catch (error) {
      await this.#handleAbortOrFailure(exec, error);
    }
  }

  /** prepare 与 Deadline 竞速；deadline 先到按准备失败处理。 */
  async #prepareWithDeadline(exec: SceneExecution, deadlineUs: bigint): Promise<StageReady> {
    const deadlineTimer = new AbortController();
    const deadlineRace = this.#clock.sleepUntil(deadlineUs, deadlineTimer.signal).then(
      () => {
        throw new PrepareDeadlineError();
      },
      (error: unknown) => {
        throw error;
      },
    );
    const prepare = this.#stage.prepare(exec.plan, deadlineUs, exec.controller.signal);
    // 败者后续 settle 不产生 unhandled rejection。
    prepare.catch(() => {});
    deadlineRace.catch(() => {});
    try {
      return await Promise.race([prepare, deadlineRace]);
    } finally {
      // prepare 先完成：取消 deadline 等待，不留挂起 waiter。
      deadlineTimer.abort(new Error("prepare_settled"));
    }
  }

  async #commitToStage(exec: SceneExecution, commitAtRuntimeUs: bigint): Promise<void> {
    const timeout = timeoutSignal(this.#clock, this.#policy.commitSendTimeoutMs);
    try {
      await this.#stage.commit(exec.plan.scene.sceneId, commitAtRuntimeUs, timeout.signal);
    } catch (error) {
      // 发送超时 = 结果不确定（可能已送达）。
      if (error instanceof Error && error.message === "timeout") {
        throw new StageCommitAmbiguousError(exec.plan.scene.sceneId, "commit send timed out");
      }
      throw error;
    } finally {
      timeout.dispose();
    }
  }

  /** 已生效/未生效 Scene 的取消路径：cancelling → stage.cancel → cancelled/uncertain。 */
  async #cancelViaStage(exec: SceneExecution, reason: string): Promise<void> {
    if (TERMINAL_STATES.has(exec.state)) {
      return;
    }
    if (exec.state !== "cancelling") {
      this.#transition(exec, "cancelling", reason);
    }
    const timeout = timeoutSignal(this.#clock, this.#policy.cancelTimeoutMs);
    let outcome: CancelOutcome;
    try {
      outcome = await this.#stage.cancel(exec.plan.scene.sceneId, reason, timeout.signal);
    } catch {
      outcome = { status: "ambiguous", reason: "cancel_delivery_failed" };
    } finally {
      timeout.dispose();
    }
    if (outcome.status === "stopped") {
      this.#transition(exec, "cancelled", reason);
      this.#finish(exec, "cancelled", reason);
    } else {
      this.#transition(exec, "uncertain", `${reason}:cancel_ambiguous`);
      this.#finish(exec, "uncertain", `${reason}:cancel_ambiguous`);
    }
  }

  /** durable 失败后的 Stage 释放：尽力而为，失败不阻塞本地失败收口。 */
  async #releaseStageQuietly(exec: SceneExecution, reason: string): Promise<void> {
    const timeout = timeoutSignal(this.#clock, this.#policy.cancelTimeoutMs);
    try {
      await this.#stage.cancel(exec.plan.scene.sceneId, reason, timeout.signal);
    } catch {
      this.#logger.log("warn", "scene_release_after_failure_failed", {
        sceneId: exec.plan.scene.sceneId,
        reason,
      });
    } finally {
      timeout.dispose();
    }
  }

  /** 等待 started/finished 通知（notifyFinished/#finish 解除）或取消。 */
  #awaitTerminal(exec: SceneExecution): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) {
          return;
        }
        settled = true;
        exec.resolveTerminalWait = null;
        reject(exec.controller.signal.reason ?? new SceneAbortedError("cancelled"));
      };
      if (exec.controller.signal.aborted) {
        onAbort();
        return;
      }
      exec.resolveTerminalWait = () => {
        if (settled) {
          return;
        }
        settled = true;
        exec.controller.signal.removeEventListener("abort", onAbort);
        exec.resolveTerminalWait = null;
        resolve();
      };
      exec.controller.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async #handleAbortOrFailure(exec: SceneExecution, error: unknown): Promise<void> {
    if (TERMINAL_STATES.has(exec.state)) {
      return;
    }
    if (error instanceof PrepareDeadlineError) {
      // 准备超时：释放已准备的资源并取消（不产生任何外部效果）。
      await this.#cancelViaStage(exec, "prepare_deadline_exceeded");
      return;
    }
    if (exec.controller.signal.aborted) {
      // 根信号中止 = 取消/断连/关闭路径（cancel/disconnect/close 都先 abort）。
      const reason = exec.cancelReason ?? "cancelled";
      await this.#cancelViaStage(exec, reason);
      return;
    }
    this.#transition(exec, "failed", `internal_error:${String(error)}`);
    this.#finish(exec, "failed", "internal_error");
  }

  #transition(
    exec: SceneExecution,
    to: DirectorInternalState,
    reason: string,
    note?: string,
  ): void {
    const from = exec.state;
    exec.state = to;
    const record: SceneLifecycleRecord = {
      sceneId: exec.plan.scene.sceneId,
      cycleId: exec.plan.scene.cycleId,
      from,
      to,
      ...(note === undefined ? {} : { reason: `${reason}|${note}` }),
      occurredAtMs: this.#wallClockMs(),
    };
    // 生命周期追加是审计事实：失败必须留下显式日志（不阻塞状态机，
    // 但绝不静默丢失——恢复对账与事后审计依赖这些记录的可观测性）。
    void this.#repository.appendLifecycle(record, new AbortController().signal).catch((error) => {
      this.#logger.log("warn", "scene_lifecycle_record_failed", {
        sceneId: record.sceneId,
        from,
        to,
        error: error instanceof Error ? error.message : "unknown",
      });
    });
    this.#logger.log("debug", "scene_state_changed", {
      sceneId: exec.plan.scene.sceneId,
      from,
      to,
      reason,
    });
  }

  #finish(exec: SceneExecution, state: SceneExecutionState, reason?: string): void {
    this.#metrics.counter("bellis_scene_execution_total", { result: state }).inc();
    exec.resolveTerminalWait?.();
    exec.resolveDone({
      sceneId: exec.plan.scene.sceneId,
      state,
      ...(reason === undefined ? {} : { reason }),
    });
    this.#wakeCloseWaiters();
  }
}
