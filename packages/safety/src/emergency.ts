import type { Clock, TimerHandle } from '@bellis/kernel';
import {
  type EmergencyOutcome,
  type EmergencyPolicy,
  EventSubscription,
  inspectObsTargets,
  ObsClient,
  runEmergency,
} from '@bellis/obs';

/** 应急连接订阅的事件：节目场景（Scenes）与输入静音（Inputs）的变化（R-27）。 */
export const EMERGENCY_EVENTS = EventSubscription.Scenes | EventSubscription.Inputs;

/** 应急连接观察到的 OBS 变化：可能是热键，也可能是手动操作或别的客户端的请求。 */
export type ObsChange =
  | { kind: 'scene'; sceneName: string }
  | { kind: 'mute'; inputName: string; muted: boolean };

/** 读出的节目场景与 Stage 源的静音状态；读不到的项为 undefined。 */
export interface ObsObserved {
  sceneName: string | undefined;
  stageMuted: boolean | undefined;
}

export interface ObsWatcher {
  /** 节目场景或输入静音变了。 */
  change(change: ObsChange): void;
  /** 连上（或断开后重新连上）了 OBS：断开期间的事件收不到。 */
  connected(): void;
}

/** 安全核执行急停动作的 OBS 通道。 */
export interface EmergencyObs {
  readonly ready: boolean;
  run(policy: EmergencyPolicy): Promise<EmergencyOutcome>;
  /** 订阅 OBS 的外部变化；没有事件来源的实现（例如只记录动作的桩）可以不提供。 */
  watch?(watcher: ObsWatcher): () => void;
  /** 读当前的节目场景与 Stage 源的静音状态（重新连上后核对）。 */
  observe?(policy: EmergencyPolicy): Promise<ObsObserved>;
}

export interface ObsCredentials {
  url: string;
  password?: string;
}

/**
 * 安全核自己独占的 OBS 应急连接（D-30）：常驻连接，断开后按固定间隔重连；
 * 急停时若未连接，先在截止时间内尝试连接一次。动作只有静音与切安全场景；
 * 另订阅节目场景与输入静音的变化交给安全核（R-27），每次连上都通知安全核，由它决定是否核对当前状态。
 */
export class ObsEmergencyConnection implements EmergencyObs {
  readonly #credentials: ObsCredentials;
  readonly #clock: Clock;
  readonly #retryMs: number;
  readonly #log: (event: string, fields: Record<string, unknown>) => void;
  readonly #watchers = new Set<ObsWatcher>();
  #client: ObsClient | undefined;
  #connecting: Promise<ObsClient> | undefined;
  #retry: TimerHandle | undefined;
  #closed = false;

  constructor(
    credentials: ObsCredentials,
    clock: Clock,
    log: (event: string, fields: Record<string, unknown>) => void,
    retryMs = 1000,
  ) {
    this.#credentials = credentials;
    this.#clock = clock;
    this.#log = log;
    this.#retryMs = retryMs;
  }

  get ready(): boolean {
    return this.#client?.connected === true;
  }

  /** 建立常驻连接；失败时按间隔重试。 */
  start(): Promise<void> {
    return this.#connect().then(
      () => undefined,
      () => undefined,
    );
  }

  async run(policy: EmergencyPolicy): Promise<EmergencyOutcome> {
    return runEmergency(await this.#ensure(), policy);
  }

  watch(watcher: ObsWatcher): () => void {
    this.#watchers.add(watcher);
    return () => this.#watchers.delete(watcher);
  }

  async observe(policy: EmergencyPolicy): Promise<ObsObserved> {
    const client = await this.#ensure();
    const [scene, mute] = await Promise.all([
      client.request('GetCurrentProgramScene'),
      client.request('GetInputMute', { inputName: policy.stageSource }),
    ]);
    const name = scene.data?.sceneName ?? scene.data?.currentProgramSceneName;
    const muted = mute.data?.inputMuted;
    return {
      sceneName: scene.ok && typeof name === 'string' ? name : undefined,
      stageMuted: mute.ok && typeof muted === 'boolean' ? muted : undefined,
    };
  }

  /** 开播预检：只读核对应急目标（见 inspectObsTargets）。不可用时以失败项返回。 */
  async inspect(policy: EmergencyPolicy): Promise<string[]> {
    try {
      return await inspectObsTargets(await this.#ensure(), policy);
    } catch (error) {
      return [`OBS 预检失败：${(error as Error).message}`];
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#retry) this.#clock.clearTimeout(this.#retry);
    this.#client?.close();
  }

  #ensure(): Promise<ObsClient> {
    return this.ready ? Promise.resolve(this.#client as ObsClient) : this.#connect();
  }

  #connect(): Promise<ObsClient> {
    this.#connecting ??= ObsClient.connect(this.#credentials.url, this.#credentials.password, {
      timeoutMs: 1000,
      eventSubscriptions: EMERGENCY_EVENTS,
    })
      .then((client) => {
        this.#client = client;
        this.#log('safety.obs-connected', {});
        client.onEvent((type, data) => this.#onEvent(type, data));
        client.onClose((reason) => {
          this.#log('safety.obs-disconnected', { reason });
          this.#scheduleRetry();
        });
        this.#notify((watcher) => watcher.connected());
        return client;
      })
      .catch((error: unknown) => {
        this.#log('safety.obs-connect-failed', { error: (error as Error).message });
        this.#scheduleRetry();
        throw error;
      })
      .finally(() => {
        this.#connecting = undefined;
      });
    return this.#connecting;
  }

  #onEvent(type: string, data: Record<string, unknown>): void {
    let change: ObsChange | undefined;
    if (type === 'CurrentProgramSceneChanged' && typeof data.sceneName === 'string') {
      change = { kind: 'scene', sceneName: data.sceneName };
    } else if (
      type === 'InputMuteStateChanged' &&
      typeof data.inputName === 'string' &&
      typeof data.inputMuted === 'boolean'
    ) {
      change = { kind: 'mute', inputName: data.inputName, muted: data.inputMuted };
    }
    if (change) {
      const observed = change;
      this.#notify((watcher) => watcher.change(observed));
    }
  }

  /** 逐个通知订阅者；单个订阅者出错只记录，不影响其他订阅者。 */
  #notify(call: (watcher: ObsWatcher) => void): void {
    for (const watcher of [...this.#watchers]) {
      try {
        call(watcher);
      } catch (error) {
        this.#log('safety.obs-watcher-failed', { error: (error as Error).message });
      }
    }
  }

  #scheduleRetry(): void {
    if (this.#closed || this.#retry) return;
    this.#retry = this.#clock.setTimeout(() => {
      this.#retry = undefined;
      if (!this.#closed && !this.ready) void this.#connect().catch(() => {});
    }, this.#retryMs);
  }
}
