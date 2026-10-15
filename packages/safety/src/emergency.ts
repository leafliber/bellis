import type { Clock, TimerHandle } from '@bellis/kernel';
import { type EmergencyOutcome, type EmergencyPolicy, ObsClient, runEmergency } from '@bellis/obs';

/** 安全核执行急停动作的 OBS 通道。 */
export interface EmergencyObs {
  readonly ready: boolean;
  run(policy: EmergencyPolicy): Promise<EmergencyOutcome>;
}

export interface ObsCredentials {
  url: string;
  password?: string;
}

/**
 * 安全核自己独占的 OBS 应急连接（D-30）：常驻连接，断开后按固定间隔重连；
 * 急停时若未连接，先在截止时间内尝试连接一次。只用于静音与切安全场景。
 */
export class ObsEmergencyConnection implements EmergencyObs {
  readonly #credentials: ObsCredentials;
  readonly #clock: Clock;
  readonly #retryMs: number;
  readonly #log: (event: string, fields: Record<string, unknown>) => void;
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
    const client = this.ready ? (this.#client as ObsClient) : await this.#connect();
    return runEmergency(client, policy);
  }

  close(): void {
    this.#closed = true;
    if (this.#retry) this.#clock.clearTimeout(this.#retry);
    this.#client?.close();
  }

  #connect(): Promise<ObsClient> {
    this.#connecting ??= ObsClient.connect(this.#credentials.url, this.#credentials.password, {
      timeoutMs: 1000,
    })
      .then((client) => {
        this.#client = client;
        this.#log('safety.obs-connected', {});
        client.onClose((reason) => {
          this.#log('safety.obs-disconnected', { reason });
          this.#scheduleRetry();
        });
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

  #scheduleRetry(): void {
    if (this.#closed || this.#retry) return;
    this.#retry = this.#clock.setTimeout(() => {
      this.#retry = undefined;
      if (!this.#closed && !this.ready) void this.#connect().catch(() => {});
    }, this.#retryMs);
  }
}
