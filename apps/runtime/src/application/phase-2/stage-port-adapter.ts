import type { JsonValue, MonotonicClock, ScenePlan } from "@bellis/contracts";
import {
  PHASE_2_AUDIT_PAYLOAD_VERSION,
  SceneCancelAckPayloadSchema,
  SceneCommitPayloadSchema,
  SceneLifecyclePayloadSchema,
  SceneReadyPayloadSchema,
  StageCapabilitiesPayloadSchema,
} from "@bellis/contracts";
import {
  StageCommitAmbiguousError,
  type CancelOutcome,
  type SceneRepositoryPort,
  type StagePort,
  type StageReady,
} from "@bellis/scene-runtime";

/**
 * Director Port 的 Control 通道适配器（docs/archive/phase-2/development-guide.md §9.2）。
 *
 * - 发送：经注入的 ControlChannel（Runtime ControlConnection 的封装）以
 *   协议优先级入队 scene.prepare/commit/cancel；
 * - 回执：ControlConnection.onStageMessage 收到的 stage.capabilities /
 *   scene.ready / started / finished / cancel.ack 经 handleStageMessage 注入，
 *   按 sceneId 关联挂起的 prepare/cancel 等待者；
 * - prepare 等待 Deadline（signal 触发即放弃）；commit 发送确认以回执/
 *   发送失败为准，连接断开视为结果不确定（StageCommitAmbiguousError）。
 */

export interface ControlChannel {
  /** 以协议消息入队服务端消息（Envelope 校验由 ControlSession 负责）。 */
  enqueueServerMessage(input: {
    readonly type: string;
    readonly payload: JsonValue;
    readonly trace: { readonly traceId: string };
  }): boolean;
  /** 当前是否有活跃 Stage 连接（无连接时 prepare 立即 unavailable）。 */
  hasStageConnection(): boolean;
  /** Trusted transport identity; never read from a Stage payload. */
  activeConnectionId?(): string | null;
  /** Stage 连接断开通知（等待中的 commit 转为结果不确定）。 */
  onDisconnected(handler: () => void): void;
}

interface PendingWaiter<T> {
  readonly sceneId: string;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  timer: AbortController;
}

export class ControlStagePortAdapter implements StagePort {
  readonly #channel: ControlChannel;
  readonly #clock: MonotonicClock;
  readonly #nextMessageId: () => string;
  readonly #prepareWaiters = new Map<string, PendingWaiter<StageReady>>();
  readonly #cancelWaiters = new Map<string, PendingWaiter<CancelOutcome>>();
  readonly #disconnectHandlers: (() => void)[] = [];
  #latestCapabilities: unknown = null;
  onPrepareSent?: (plan: ScenePlan) => void;
  beforePrepare?: (plan: ScenePlan, signal: AbortSignal) => Promise<void>;

  constructor(options: {
    readonly channel: ControlChannel;
    readonly clock: MonotonicClock;
    readonly nextMessageId: () => string;
  }) {
    this.#channel = options.channel;
    this.#clock = options.clock;
    this.#nextMessageId = options.nextMessageId;
    void options;
    this.#channel.onDisconnected(() => {
      // 能力快照按连接代际清除：重连后的 Stage 是新装配，必须重新上报
      // stage.capabilities（旧连接声明的能力不得延续到新代际）。
      this.#latestCapabilities = null;
      // 等待中的取消：结果不确定。
      for (const [sceneId, waiter] of this.#cancelWaiters) {
        this.#cancelWaiters.delete(sceneId);
        waiter.timer.abort(new Error("disposed"));
        waiter.resolve({ status: "ambiguous", reason: "stage_disconnected" });
      }
      for (const handler of Array.from(this.#disconnectHandlers)) {
        handler();
      }
    });
  }

  /** ControlConnection 阶段消息入口（应用层在 onStageMessage 中调用）。 */
  handleStageMessage(type: string, payload: unknown, nowUs: bigint): void {
    switch (type) {
      case "stage.capabilities": {
        // 能力快照留存：应用层编译输入由此读取（Schema 校验可解析才接收）。
        const parsed = StageCapabilitiesPayloadSchema.safeParse(payload);
        if (parsed.success) {
          this.#latestCapabilities = parsed.data;
        }
        return;
      }
      case "scene.ready": {
        const parsed = SceneReadyPayloadSchema.safeParse(payload);
        if (!parsed.success) {
          return;
        }
        const waiter = this.#prepareWaiters.get(parsed.data.sceneId);
        if (waiter !== undefined) {
          this.#prepareWaiters.delete(parsed.data.sceneId);
          waiter.timer.abort(new Error("settled"));
          waiter.resolve({
            lanes: parsed.data.lanes.map((lane) => ({
              lane: lane.lane,
              status: lane.status,
              ...(lane.reason === undefined ? {} : { reason: lane.reason }),
              cueIds: [...lane.cueIds],
            })),
            preparedAtStageUs: BigInt(parsed.data.preparedAtStageUs),
          });
        }
        return;
      }
      case "scene.cancel.ack": {
        const parsed = SceneCancelAckPayloadSchema.safeParse(payload);
        if (!parsed.success) {
          return;
        }
        const waiter = this.#cancelWaiters.get(parsed.data.sceneId);
        if (waiter !== undefined) {
          this.#cancelWaiters.delete(parsed.data.sceneId);
          waiter.timer.abort(new Error("settled"));
          const allStopped = parsed.data.lanes.every((lane) => lane.stopped);
          waiter.resolve(
            allStopped
              ? { status: "stopped" }
              : { status: "ambiguous", reason: "lane_stop_failed" },
          );
        }
        return;
      }
      case "scene.started":
      case "scene.finished":
        // 由 PerformanceService 直接消费（时钟偏差/完成聚合），Port 不等待。
        return;
      default:
        void nowUs;
        return;
    }
  }

  /** Stage 连接已建立（clientType=stage 的活跃连接出现时调用）。 */
  markConnected(): void {
    // 连接存在性由 ControlChannel.hasStageConnection 判定；此入口保留给
    // 应用层显式声明（例如多连接装配区分 Stage 与普通订阅者）。
  }

  /** 最近一次 stage.capabilities 快照（未上报或校验失败为 null）。 */
  get latestStageCapabilities(): unknown {
    return this.#latestCapabilities;
  }

  prepare(plan: ScenePlan, deadlineUs: bigint, signal: AbortSignal): Promise<StageReady> {
    if (plan.effects !== undefined && this.beforePrepare !== undefined) {
      return this.beforePrepare(plan, signal).then(() => {
        signal.throwIfAborted();
        if (this.#clock.nowUs() >= deadlineUs) throw new Error("effect_prepare_deadline");
        return this.#sendPrepare(plan, deadlineUs, signal);
      });
    }
    return this.#sendPrepare(plan, deadlineUs, signal);
  }

  #sendPrepare(plan: ScenePlan, deadlineUs: bigint, signal: AbortSignal): Promise<StageReady> {
    if (!this.#channel.hasStageConnection()) {
      return Promise.resolve({
        lanes: plan.scene.groups.flatMap((group) =>
          group.lanes.map((lane) => ({
            lane,
            status: "unavailable",
            reason: "stage_not_connected",
            cueIds: [],
          })),
        ),
        preparedAtStageUs: 0n,
      });
    }
    const sceneId = plan.scene.sceneId;
    const sent = this.#channel.enqueueServerMessage({
      type: "scene.prepare",
      payload: {
        plan: plan as unknown as JsonValue,
        prepareDeadlineUs: deadlineUs.toString(),
      },
      trace: { traceId: this.#traceIdFor(sceneId) },
    });
    if (!sent) {
      return Promise.resolve({
        lanes: [{ lane: "audio", status: "unavailable", reason: "send_failed", cueIds: [] }],
        preparedAtStageUs: 0n,
      });
    }
    this.onPrepareSent?.(plan);
    return new Promise<StageReady>((resolve, reject) => {
      const timer = new AbortController();
      const waiter: PendingWaiter<StageReady> = {
        sceneId,
        resolve,
        reject,
        timer,
      };
      this.#prepareWaiters.set(sceneId, waiter);
      // Deadline / 取消：未收到 ready 即按全部不可用结算（Director 决定取消）。
      void this.#clock.sleepUntil(deadlineUs, timer.signal).then(
        () => {
          if (this.#prepareWaiters.get(sceneId) === waiter) {
            this.#prepareWaiters.delete(sceneId);
            resolve({
              lanes: plan.scene.groups.flatMap((group) =>
                group.lanes.map((lane) => ({
                  lane,
                  status: "unavailable",
                  reason: "prepare_deadline",
                  cueIds: [],
                })),
              ),
              preparedAtStageUs: this.#clock.nowUs(),
            });
          }
        },
        () => {},
      );
      signal.addEventListener(
        "abort",
        () => {
          if (this.#prepareWaiters.get(sceneId) === waiter) {
            this.#prepareWaiters.delete(sceneId);
            timer.abort(new Error("aborted"));
            reject(signal.reason ?? new Error("aborted"));
          }
        },
        { once: true },
      );
    });
  }

  commit(sceneId: string, commitAtRuntimeUs: bigint, signal: AbortSignal): Promise<void> {
    const parsed = SceneCommitPayloadSchema.safeParse({
      sceneId,
      cycleId: this.#cycleIdOf(sceneId),
      commitAtRuntimeUs: commitAtRuntimeUs.toString(),
    });
    if (!parsed.success) {
      return Promise.reject(new Error("commit payload invalid"));
    }
    const sent = this.#channel.enqueueServerMessage({
      type: "scene.commit",
      payload: parsed.data as unknown as JsonValue,
      trace: { traceId: this.#traceIdFor(sceneId) },
    });
    if (!sent) {
      // 入队失败 = 确定性失败（消息从未写出）。
      return Promise.reject(new Error("scene_commit_send_failed"));
    }
    // 写出后的送达结果不可知（无 commit ack 协议）：以发送成功即视为
    // 已交付 Control 可靠通道；断线竞态由 onDisconnected → uncertain 覆盖。
    signal.addEventListener("abort", () => {}, { once: true });
    return Promise.resolve();
  }

  cancel(sceneId: string, reason: string, signal: AbortSignal): Promise<CancelOutcome> {
    const sent = this.#channel.enqueueServerMessage({
      type: "scene.cancel",
      payload: { sceneId, cycleId: this.#cycleIdOf(sceneId), reason },
      trace: { traceId: this.#traceIdFor(sceneId) },
    });
    if (!sent) {
      return Promise.resolve({ status: "ambiguous", reason: "cancel_send_failed" });
    }
    return new Promise<CancelOutcome>((resolve) => {
      const timer = new AbortController();
      const waiter: PendingWaiter<CancelOutcome> = {
        sceneId,
        resolve,
        reject: () => {},
        timer,
      };
      this.#cancelWaiters.set(sceneId, waiter);
      const timeoutMs = 1000;
      void this.#clock
        .sleepUntil(this.#clock.nowUs() + BigInt(timeoutMs) * 1000n, timer.signal)
        .then(
          () => {
            if (this.#cancelWaiters.get(sceneId) === waiter) {
              this.#cancelWaiters.delete(sceneId);
              resolve({ status: "ambiguous", reason: "cancel_ack_timeout" });
            }
          },
          () => {},
        );
      signal.addEventListener(
        "abort",
        () => {
          if (this.#cancelWaiters.get(sceneId) === waiter) {
            this.#cancelWaiters.delete(sceneId);
            timer.abort(new Error("aborted"));
            resolve({ status: "ambiguous", reason: "cancel_aborted" });
          }
        },
        { once: true },
      );
    });
  }

  onStageDisconnected(handler: () => void): void {
    this.#disconnectHandlers.push(handler);
  }

  /** 已断开期间提交视为不确定（Director 在途 commit 的兜底路径）。 */
  static ambiguousFor(sceneId: string, cause: string): StageCommitAmbiguousError {
    return new StageCommitAmbiguousError(sceneId, cause);
  }

  /** sceneId→cycleId/traceId 索引（submit 登记；容量 64，按登记顺序淘汰）。 */
  readonly #cycleIds = new Map<string, string>();
  readonly #sceneTraces = new Map<string, string>();
  #cycleOrder: string[] = [];

  /** 记录 sceneId→cycleId/traceId（submit 时由应用层登记，commit/cancel 复用）。 */
  registerScene(sceneId: string, cycleId: string, traceId?: string): void {
    this.#cycleIds.set(sceneId, cycleId);
    this.#cycleOrder.push(sceneId);
    if (traceId !== undefined) {
      this.#sceneTraces.set(sceneId, traceId);
    }
    // 容量上限：淘汰最旧登记（活跃 Scene 数由 Director 限幅，正常不会触达）。
    while (this.#cycleOrder.length > 64) {
      const oldest = this.#cycleOrder.shift();
      if (oldest !== undefined && oldest !== sceneId) {
        this.#cycleIds.delete(oldest);
        this.#sceneTraces.delete(oldest);
      } else {
        break;
      }
    }
  }

  #cycleIdOf(sceneId: string): string {
    return this.#cycleIds.get(sceneId) ?? "00000000-0000-4000-8000-000000000000";
  }

  /** Scene 级稳定 trace（submit 生成；prepare/commit/cancel 共用同一根）。 */
  #traceIdFor(sceneId?: string): string {
    const bound = sceneId === undefined ? null : this.#sceneTraces.get(sceneId);
    return bound ?? this.#traceId();
  }

  #traceId(): string {
    return this.#nextMessageId().replaceAll("-", "").slice(0, 31) + "0";
  }
}

/** SceneRepositoryPort → PersistenceClient 适配（§9.3 记录与持久化）。 */
export class PersistenceSceneRepository implements SceneRepositoryPort {
  readonly #client: {
    commitScene: (input: unknown) => Promise<unknown>;
    appendRecord: (input: unknown) => Promise<unknown>;
  };
  readonly #trace: { readonly traceId: string };
  readonly #newRecordId: () => string;
  #sessionId: string | null = null;

  constructor(options: {
    readonly client: {
      commitScene: (input: unknown) => Promise<unknown>;
      appendRecord: (input: unknown) => Promise<unknown>;
    };
    readonly traceId: string;
    readonly newRecordId: () => string;
  }) {
    this.#client = options.client;
    this.#trace = { traceId: options.traceId };
    this.#newRecordId = options.newRecordId;
  }

  /**
   * 绑定当前逻辑 Session（Stage 连接出现时由应用层调用）：生命周期
   * Record 必须携带真实 sessionId（Record Schema 要求 UUID，占位值会被
   * 持久化层拒绝——审计事实不允许静默丢失）。
   */
  bindSessionId(sessionId: string): void {
    this.#sessionId = sessionId;
  }

  /** Scene 级 trace 根登记（提交链共用同一根；容量 64 按登记顺序淘汰）。 */
  readonly #sceneTraces = new Map<string, string>();
  #sceneTraceOrder: string[] = [];

  bindSceneTrace(sceneId: string, traceId: string): void {
    this.#sceneTraces.set(sceneId, traceId);
    this.#sceneTraceOrder.push(sceneId);
    while (this.#sceneTraceOrder.length > 64) {
      const oldest = this.#sceneTraceOrder.shift();
      if (oldest !== undefined && oldest !== sceneId) {
        this.#sceneTraces.delete(oldest);
      } else {
        break;
      }
    }
  }

  /** Scene 的 trace 根（未登记回落装配级 trace：Trace 事实不缺席）。 */
  #sceneTraceOf(sceneId: string): { readonly traceId: string } {
    const bound = this.#sceneTraces.get(sceneId);
    return bound === undefined ? this.#trace : { traceId: bound };
  }

  async commit(
    input: {
      readonly sessionId: string;
      readonly plan: ScenePlan;
      readonly idempotencyKey: string;
      readonly requestFingerprint: string;
    },
    _signal: AbortSignal,
  ): Promise<{ sceneId: string; committedAtMs: number; duplicate: boolean }> {
    const result = (await this.#client.commitScene({
      sceneId: input.plan.scene.sceneId,
      cycleId: input.plan.scene.cycleId,
      sessionId: input.sessionId,
      scene: input.plan.scene,
      plan: input.plan,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      watermarks: [],
      outbox: [],
      trace: this.#sceneTraceOf(input.plan.scene.sceneId),
    })) as { sceneId: string; committedAtMs: number; duplicate: boolean };
    return result;
  }

  async appendLifecycle(
    record: {
      readonly sceneId: string;
      readonly cycleId: string;
      readonly from: string;
      readonly to: string;
      readonly reason?: string;
      readonly occurredAtMs: number;
    },
    _signal: AbortSignal,
  ): Promise<void> {
    const sessionId = this.#sessionId;
    if (sessionId === null) {
      // 未解析到真实 Session 前不写假会话：显式失败由 Director 记录日志。
      throw new Error("scene_repository_session_unbound");
    }
    await this.#client.appendRecord({
      record: {
        schemaVersion: 1,
        recordId: this.#newRecordId(),
        sessionId,
        recordType: "scene_lifecycle",
        aggregateId: `scene-lifecycle:${record.sceneId}`,
        traceId: this.#sceneTraceOf(record.sceneId).traceId,
        occurredAtMs: record.occurredAtMs,
        payload: SceneLifecyclePayloadSchema.parse({
          payloadVersion: PHASE_2_AUDIT_PAYLOAD_VERSION,
          sceneId: record.sceneId,
          cycleId: record.cycleId,
          from: record.from,
          to: record.to,
          ...(record.reason === undefined ? {} : { reason: record.reason }),
        }),
      },
      trace: this.#sceneTraceOf(record.sceneId),
    });
  }
}
