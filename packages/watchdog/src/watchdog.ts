import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { connect, RpcPeer } from '@bellis/channel';
import { type EmergencyPolicy, ObsClient, runEmergency } from '@bellis/obs';
import { HostHeartbeat, HostStopping, type ObsSecret, Role } from '@bellis/protocol';

export interface WatchdogOptions {
  channelPath: string;
  key: Uint8Array;
  obs: ObsSecret;
  policy: EmergencyPolicy;
  /** 超过这么久收不到宿主心跳即执行应急动作。 */
  heartbeatTimeoutMs: number;
  log: (event: string, fields?: Record<string, unknown>) => void;
  reconnectDelayMs?: number;
}

/**
 * 外部看门狗（R-14）：独立进程，不依赖宿主与 Stage。
 * 以 `watchdog` 角色连接宿主并接收心跳；心跳超时或连接意外断开时，用一次 RequestBatch
 * 静音 Stage 源、切到安全场景（按策略停推流），然后呼叫操作员。宿主计划内停止不触发。
 * 执行过一次后，直到再次收到心跳才会重新武装，避免反复动作。
 */
export class Watchdog {
  readonly #options: WatchdogOptions;
  #obs: ObsClient | undefined;
  #obsConnecting: Promise<ObsClient> | undefined;
  #acted = false;
  #stopped = false;

  constructor(options: WatchdogOptions) {
    this.#options = options;
  }

  start(): void {
    void this.#ensureObs().catch(() => {});
    void this.#watchHost();
  }

  stop(): void {
    this.#stopped = true;
    this.#obs?.close();
  }

  async #watchHost(): Promise<void> {
    const { log } = this.#options;
    let waitingLogged = false;
    while (!this.#stopped) {
      try {
        const connection = await connect(this.#options.channelPath, Role.Watchdog, {
          key: this.#options.key,
        });
        const rpc = new RpcPeer(connection, { timeoutMs: 2000 });
        waitingLogged = false;
        let planned = false;
        let timer: NodeJS.Timeout | undefined;
        const arm = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            void this.#act('heartbeat-lost');
            connection.destroy();
          }, this.#options.heartbeatTimeoutMs);
        };
        rpc.onNotification(HostHeartbeat, () => {
          this.#acted = false;
          arm();
        });
        rpc.onNotification(HostStopping, () => {
          planned = true;
          clearTimeout(timer);
        });
        arm();
        log('watchdog.connected');
        await once(connection, 'close');
        clearTimeout(timer);
        if (planned) {
          log('watchdog.host-stopped');
        } else {
          log('watchdog.host-lost');
          await this.#act('connection-lost');
        }
      } catch (error) {
        if (!waitingLogged) {
          log('watchdog.waiting-for-host', { error: (error as Error).message });
          waitingLogged = true;
        }
      }
      await sleep(this.#options.reconnectDelayMs ?? 200);
    }
  }

  async #act(reason: string): Promise<void> {
    if (this.#acted || this.#stopped) return;
    this.#acted = true;
    const { log } = this.#options;
    log('watchdog.acting', { reason });
    try {
      const client = await this.#ensureObs();
      const outcome = await runEmergency(client, this.#options.policy);
      log('watchdog.acted', { reason, ok: outcome.ok, results: outcome.results });
    } catch (error) {
      log('watchdog.act-failed', { reason, error: (error as Error).message });
    }
    // 呼叫操作员的渠道待定；P0 先记录事件。
    log('watchdog.paged', { reason });
  }

  #ensureObs(): Promise<ObsClient> {
    if (this.#obs?.connected) return Promise.resolve(this.#obs);
    this.#obsConnecting ??= ObsClient.connect(this.#options.obs.url, this.#options.obs.password, {
      timeoutMs: 1000,
    })
      .then((client) => {
        this.#obs = client;
        this.#options.log('watchdog.obs-connected');
        return client;
      })
      .finally(() => {
        this.#obsConnecting = undefined;
      });
    return this.#obsConnecting;
  }
}
