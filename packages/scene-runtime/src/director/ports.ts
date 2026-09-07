import type { ScenePlan } from "@bellis/contracts";

/**
 * Scene Director 的抽象 Port 边界（docs/archive/phase-2/development-guide.md §6.3）。
 *
 * 只允许注入抽象能力：Stage 传输、Scene 持久化、时钟、日志与指标。
 * 禁止注入 Fastify/WebSocket/SQLite 具体对象——适配器在应用层组装
 *（P4），Director 通过这些 Port 与外界交互。
 */

/** Stage 单 Lane 的准备结果（stage.ready 的领域形态，时间转 bigint）。 */
export interface StageLaneReady {
  readonly lane: "audio" | "subtitle" | "avatar" | "game" | "overlay";
  readonly status: "ready" | "unavailable";
  readonly reason?: string;
  readonly cueIds: readonly string[];
}

/** StagePort.prepare 的结果：逐 Lane 报告 + Stage 本地准备完成时刻。 */
export interface StageReady {
  readonly lanes: readonly StageLaneReady[];
  readonly preparedAtStageUs: bigint;
}

/**
 * Stage Commit 结果不确定（发送后既不知道送达也不知道失败，例如连接在
 * 写出后立刻断开且无回执）。适配器必须把它与确定的失败区分开：
 * 不确定 → Scene 进入 uncertain，绝不自动重试外部效果。
 */
export class StageCommitAmbiguousError extends Error {
  constructor(
    readonly sceneId: string,
    message: string,
  ) {
    super(message);
    this.name = "StageCommitAmbiguousError";
  }
}

/** StagePort.cancel 的结果：stopped=确认停止并释放；ambiguous=结果不确定。 */
export interface CancelOutcome {
  readonly status: "stopped" | "ambiguous";
  readonly reason?: string;
}

/**
 * Runtime → Stage 的命令通道。prepare 只允许验证与缓冲资源；
 * commit 只在持久化成功后调用；cancel 用于任意未终态 Scene 的停止。
 */
export interface StagePort {
  prepare(plan: ScenePlan, deadlineUs: bigint, signal: AbortSignal): Promise<StageReady>;
  commit(sceneId: string, commitAtRuntimeUs: bigint, signal: AbortSignal): Promise<void>;
  cancel(sceneId: string, reason: string, signal: AbortSignal): Promise<CancelOutcome>;
}

/** durable commitScene 的输入（领域形态；P4 适配器映射到 Persistence）。 */
export interface DurableSceneCommit {
  readonly sessionId: string;
  readonly plan: ScenePlan;
  readonly idempotencyKey: string;
  /** 调用方提供的请求摘要（幂等冲突检测用，1..256 稳定字符串）。 */
  readonly requestFingerprint: string;
}

export interface DurableCommitResult {
  readonly sceneId: string;
  readonly committedAtMs: number;
  readonly duplicate: boolean;
}

/** durable 提交失败（事务回滚：Scene/Record/Watermark/Outbox 均不存在）。 */
export class DurableCommitError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DurableCommitError";
  }
}

/**
 * Scene 生命周期追加记录（append-only；P4 适配器映射为版本化
 * SessionRecord payload，可追加不可改写历史）。
 */
export interface SceneLifecycleRecord {
  readonly sceneId: string;
  readonly cycleId: string;
  readonly from: string;
  readonly to: string;
  readonly reason?: string;
  /** 审计墙钟毫秒（可注入），单调执行时间不进入持久层。 */
  readonly occurredAtMs: number;
}

export interface SceneRepositoryPort {
  commit(input: DurableSceneCommit, signal: AbortSignal): Promise<DurableCommitResult>;
  appendLifecycle(record: SceneLifecycleRecord, signal: AbortSignal): Promise<void>;
  /**
   * 绑定 Scene 级 trace 根（可选能力）：提交链（Signal→编译→DB）共用
   * 同一 traceId 时由应用层登记，durable commit 与生命周期 Record 携带
   * 该根，实现跨层 Trace 连续；未绑定的实现沿用装配级 trace。
   */
  bindSceneTrace?(sceneId: string, traceId: string): void;
}
