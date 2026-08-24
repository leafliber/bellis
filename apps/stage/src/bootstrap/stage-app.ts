import type { JsonValue, MonotonicClock } from "@bellis/contracts";
import { StageControlClient, type StageControlEvent } from "../control/stage-control-client.js";
import type { StageSocket } from "../control/stage-socket.js";
import { LaneRegistry } from "../lanes/lane-registry.js";
import { SceneClient } from "../scenes/scene-client.js";
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
  /** Media Stream announce 处理（P3 AudioWorklet Lane 接管；P2 记录并确认）。 */
  readonly onMediaAnnounce?: (payload: unknown) => void;
}

export class StageApp {
  readonly #clock: MonotonicClock;
  readonly #options: StageAppOptions;
  readonly #timeline: CueTimeline;
  readonly #lanes = new LaneRegistry();
  #state: StageAppState = "booting";
  #control: StageControlClient | null = null;
  #scenes: SceneClient | null = null;
  #audioArmed = false;
  #lastError: { code: string; message: string } | null = null;
  #closed = false;
  #started = false;

  constructor(options: StageAppOptions) {
    this.#clock = options.clock;
    this.#options = options;
    this.#timeline = new CueTimeline(options.clock);
  }

  get state(): StageAppState {
    return this.#state;
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
      clock: this.#clock,
      timeline: this.#timeline,
      lanes: this.#lanes,
      clockEstimate: () => this.#control?.clockEstimate ?? null,
      send: (type, payload) => control.sendClient(type, payload as JsonValue) ?? false,
    });
    await control.connect();
  }

  #onControlEvent(event: StageControlEvent): void {
    switch (event.type) {
      case "state": {
        if (event.state === "active") {
          this.#setState("control_ready");
        } else if (event.state === "reconnect_wait" && !this.#closed) {
          // 重连即新连接代际：未提交准备缓存丢弃，时钟重新校准。
          this.#scenes?.onConnectionGenerationChange();
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

  #dispatchServerMessage(type: string, payload: unknown): void {
    const scenes = this.#scenes;
    if (scenes === null) {
      return;
    }
    switch (type) {
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
        this.#options.onMediaAnnounce?.(payload);
        return;
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
