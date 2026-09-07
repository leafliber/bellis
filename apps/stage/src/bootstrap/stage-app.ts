import type { JsonValue, MonotonicClock } from "@bellis/contracts";
import { StageControlClient, type StageControlEvent } from "../control/stage-control-client.js";
import type { StageSocket } from "../control/stage-socket.js";
import { LaneRegistry } from "../lanes/lane-registry.js";
import { SceneClient, type SpeechTextPublisher } from "../scenes/scene-client.js";
import { CueTimeline } from "../timeline/cue-timeline.js";

/**
 * Stage 应用引导状态机（docs/phase-2-development-guide.md §7.1）。
 *
 * ```text
 * booting → auth_ready → control_ready → clock_ready → performance_ready
 *                                             ↘ degraded
 * 任意状态 → reconnecting → clock_ready（重新校准）
 * 任意状态 → closing → closed
 * ```
 *
 * - 浏览器自动播放限制是正式前置条件：audioArmed=false 时 Stage 不宣告
 *   Audio Lane Ready（Audio Arm 由 UI 用户手势触发，P3 的 AudioWorklet
 *   Adapter 依赖该状态；P2 的 Fake Lane 同样遵守）。
 * - 统一 close()：Control 客户端、Scene 客户端、Timeline、Lane 注册表
 *   全部关闭，零残留监听/定时器/Socket。
 * - 认证、Socket 工厂与能力清单注入：核心不绑定 REST/浏览器 API。
 */

export type StageAppState =
  | "booting"
  | "auth_ready"
  | "control_ready"
  | "clock_ready"
  | "performance_ready"
  | "degraded"
  | "reconnecting"
  | "closing"
  | "closed";

export interface StageAuthResult {
  readonly sessionId: string;
  readonly controlUrl: string;
}

export interface StageAppOptions {
  readonly clock: MonotonicClock;
  readonly nextMessageId: () => string;
  readonly capabilities: JsonValue;
  readonly socketFactory: () => StageSocket;
  readonly authenticate: () => Promise<StageAuthResult>;
  readonly heartbeatIntervalMs?: number;
  readonly clockSamplesRequired?: number;
  readonly onStateChange?: (state: StageAppState, previous: StageAppState) => void;
  /** Media Stream announce 处理（装配层建立有界缓冲后回 media.stream.ready）。 */
  readonly onMediaAnnounce?: (payload: unknown, sendReady: (payload: unknown) => boolean) => void;
  /** Runtime 关闭媒体 Stream（media.stream.closed）：释放 Registry 槽位。 */
  readonly onMediaStreamClosed?: (streamId: string, finalSequence?: bigint) => void;
  /**
   * 控制代际变化：Runtime 已随断线取消全部帧任务（Stream 不跨连接
   * 复活）——媒体 Registry 必须同步失效，否则未收到 closed 的槽位
   * 永久遗留（媒体连接存活不清理是泄漏窗口）。
   */
  readonly onMediaStreamsInvalidate?: () => void;
  /** Lane 注册表（缺省空注册表：无 Lane 时 prepare 全部 lane_not_available）。 */
  readonly laneRegistry?: LaneRegistry;
  /** plan.speech 文本 → 字幕 Lane（P3 装配注入）。 */
  readonly speechPublisher?: SpeechTextPublisher;
  /** Scene 状态事件（UI/E2E 断言；scheduled 事件携带映射后的目标时刻）。 */
  readonly onSceneEvent?: (event: {
    sceneId: string;
    state: string;
    reason?: string;
    targetLocalUs?: bigint;
  }) => void;
  /** Lane 生效时刻（偏差指标的浏览器侧事实来源）。 */
  readonly onLaneStarted?: (report: {
    readonly sceneId: string;
    readonly lane: string;
    readonly targetLocalUs: bigint;
    readonly startedAtStageUs: bigint;
    readonly late: boolean;
  }) => void;
}

export class StageApp {
  readonly #clock: MonotonicClock;
  readonly #options: StageAppOptions;
  readonly #timeline: CueTimeline;
  readonly #lanes: LaneRegistry;
  #state: StageAppState = "booting";
  #control: StageControlClient | null = null;
  #scenes: SceneClient | null = null;
  #audioArmed = false;
  #lastError: { code: string; message: string } | null = null;
  #closed = false;
  #started = false;
  #sessionId: string | null = null;

  constructor(options: StageAppOptions) {
    this.#clock = options.clock;
    this.#options = options;
    this.#timeline = new CueTimeline(options.clock);
    this.#lanes = options.laneRegistry ?? new LaneRegistry();
  }

  get state(): StageAppState {
    return this.#state;
  }

  /** 认证后的逻辑 Session（booting 阶段为 null）。 */
  get sessionId(): string | null {
    return this.#sessionId;
  }

  get audioArmed(): boolean {
    return this.#audioArmed;
  }

  get lastError(): { code: string; message: string } | null {
    return this.#lastError;
  }

  get lanes(): LaneRegistry {
    return this.#lanes;
  }

  /** 用户手势成功 resume AudioContext 后调用（自动播放前置条件）。 */
  armAudio(): void {
    this.#audioArmed = true;
    // 能力随代际重新上报（如已连接）。
    this.#control?.sendClient("stage.capabilities", { capabilities: this.#options.capabilities });
  }

  async start(): Promise<void> {
    if (this.#closed || this.#started) {
      throw new Error("stage_app_already_started");
    }
    this.#started = true;
    const auth = await this.#options.authenticate();
    this.#sessionId = auth.sessionId;
    this.#setState("auth_ready");

    const control = new StageControlClient({
      url: auth.controlUrl,
      sessionId: auth.sessionId,
      socketFactory: this.#options.socketFactory,
      clock: this.#clock,
      nextMessageId: this.#options.nextMessageId,
      capabilities: this.#options.capabilities,
      heartbeatIntervalMs: this.#options.heartbeatIntervalMs ?? 30_000,
      clockSamplesRequired: this.#options.clockSamplesRequired ?? 3,
      reconnectBaseMs: 500,
      reconnectMaxMs: 8_000,
      onEvent: (event) => this.#onControlEvent(event),
    });
    this.#control = control;
    this.#scenes = new SceneClient({
      sessionId: auth.sessionId,
      clock: this.#clock,
      timeline: this.#timeline,
      lanes: this.#lanes,
      clockEstimate: () => this.#control?.clockEstimate ?? null,
      send: (type, payload) => control.sendClient(type, payload as JsonValue) ?? false,
      ...(this.#options.speechPublisher === undefined
        ? {}
        : { speechPublisher: this.#options.speechPublisher }),
      ...(this.#options.onSceneEvent === undefined ? {} : { onEvent: this.#options.onSceneEvent }),
      ...(this.#options.onLaneStarted === undefined
        ? {}
        : { onLaneStarted: this.#options.onLaneStarted }),
    });
    await control.connect();
  }

  /** Runtime 时钟域偏移估计（runtime − stage；clock_ready 前为 null）。 */
  runtimeOffsetUs(): bigint | null {
    return this.#control?.clockEstimate?.runtimeOffsetUs ?? null;
  }

  /** Media announce 转发（装配层持有媒体客户端时使用）。 */
  announceMedia(payload: unknown): void {
    const control = this.#control;
    if (control === null) {
      return;
    }
    this.#options.onMediaAnnounce?.(payload, (ready) =>
      control.sendClient("media.stream.ready", ready as JsonValue),
    );
  }

  #onControlEvent(event: StageControlEvent): void {
    switch (event.type) {
      case "state": {
        if (event.state === "active") {
          this.#setState("control_ready");
        } else if (event.state === "reconnect_wait" && !this.#closed) {
          // 重连即新连接代际：未提交准备缓存丢弃，时钟重新校准；媒体
          // Stream 随 Runtime 侧取消一并失效（Registry 槽位不遗留）。
          this.#scenes?.onConnectionGenerationChange();
          this.#options.onMediaStreamsInvalidate?.();
          this.#setState("reconnecting");
        }
        return;
      }
      case "clock_ready": {
        if (this.#state === "control_ready" || this.#state === "reconnecting") {
          this.#setState("clock_ready");
          this.#setState("performance_ready");
        }
        return;
      }
      case "protocol_error": {
        this.#lastError = { code: event.code, message: event.message };
        if (this.#state === "performance_ready" || this.#state === "clock_ready") {
          this.#setState("degraded");
        }
        return;
      }
      case "server_message": {
        this.#dispatchServerMessage(event.envelope.type, event.envelope.payload);
        return;
      }
      default:
        return;
    }
  }

  audioRendered(sceneId: string, samples: number, atUs: bigint): void {
    this.#scenes?.audioRendered(sceneId, samples, atUs);
  }
  subtitleApplied(sceneId: string, start: number, end: number, atUs: bigint): void {
    this.#scenes?.subtitleApplied(sceneId, start, end, atUs);
  }

  #dispatchServerMessage(type: string, payload: unknown): void {
    const scenes = this.#scenes;
    if (scenes === null) {
      return;
    }
    switch (type) {
      case "scene.effect.seal":
        scenes.sealEffects(payload);
        break;
      case "scene.effect.released":
        scenes.releaseEffect(payload);
        break;
      case "scene.effect.binding":
        scenes.bindAudioEffect(payload);
        return;
      case "scene.effect.ack":
        scenes.acknowledgeEffect(payload);
        return;
      case "scene.prepare":
        void scenes.handlePrepare(payload);
        return;
      case "scene.commit": {
        const commit = payload as { sceneId?: unknown; commitAtRuntimeUs?: unknown };
        if (typeof commit.sceneId === "string" && typeof commit.commitAtRuntimeUs === "string") {
          scenes.handleCommit(commit.sceneId, BigInt(commit.commitAtRuntimeUs));
        }
        return;
      }
      case "scene.cancel": {
        const cancel = payload as { sceneId?: unknown; reason?: unknown };
        if (typeof cancel.sceneId === "string" && typeof cancel.reason === "string") {
          void scenes.handleCancel(cancel.sceneId, cancel.reason);
        }
        return;
      }
      case "media.stream.announce":
        this.announceMedia(payload);
        return;
      case "media.stream.closed": {
        // Runtime → Stage 方向的 Stream 关闭（either-direction 类型）：
        // 本地关闭 Registry 槽位即可，不回发（避免关闭回执风暴）。
        // finalSequence 为关闭边界：closed 与帧跨连接乱序时，边界内
        // 严格连续的迟到尾帧仍可入账。
        const closed = payload as { streamId?: unknown; finalSequence?: unknown };
        if (typeof closed.streamId === "string") {
          this.#options.onMediaStreamClosed?.(
            closed.streamId,
            typeof closed.finalSequence === "string" ? BigInt(closed.finalSequence) : undefined,
          );
        }
        return;
      }
      case "session.snapshot":
        // 重连对账：快照到达说明 replay 缺口走完整快照路径；未提交准备
        // 已随代际变化丢弃，不自动重播 uncertain Scene（§7.3）。
        return;
      default:
        return;
    }
  }

  #setState(state: StageAppState): void {
    if (this.#state === state) {
      return;
    }
    const previous = this.#state;
    this.#state = state;
    this.#options.onStateChange?.(state, previous);
  }

  /** 统一关闭：Scene → Control → Timeline → Lanes，全链路零残留。 */
  async close(reason = "stage_app_close"): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#setState("closing");
    this.#scenes?.close();
    this.#control?.close(reason);
    this.#timeline.close();
    await this.#lanes.close();
    this.#setState("closed");
  }
}
