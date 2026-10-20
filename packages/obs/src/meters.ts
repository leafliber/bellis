import { ObsClient, type ObsConnectOptions } from './client.ts';
import { EventSubscription } from './protocol.ts';

/** obs-websocket 的 InputVolumeMeters 事件订阅位（高频事件，约每 50ms 一次）。 */
export const INPUT_VOLUME_METERS = EventSubscription.InputVolumeMeters;

/** 一个输入此刻的音量表读数。 */
export interface MeterLevel {
  inputName: string;
  /** 各声道推子之前的峰值（inputPeak）中最大的，dBFS；无声为 -Infinity。 */
  peakDb: number;
}

/**
 * 只读的 OBS 音量表连接（Stage 文档“对齐”）：只订阅 InputVolumeMeters，只能读输入的音频同步偏移，
 * 不暴露任何别的请求，所以发不出控制请求。宿主用同一份 OBS 凭据建立，只交给被授予 `obs.meters` 的实例；
 * 与 OBS 控制（`obs.control`）的连接分开。
 */
export class ObsMeters {
  readonly #client: ObsClient;

  private constructor(client: ObsClient) {
    this.#client = client;
  }

  static async connect(
    url: string,
    password: string | undefined,
    options: Omit<ObsConnectOptions, 'eventSubscriptions'> = {},
  ): Promise<ObsMeters> {
    const client = await ObsClient.connect(url, password, {
      ...options,
      eventSubscriptions: INPUT_VOLUME_METERS,
    });
    return new ObsMeters(client);
  }

  get connected(): boolean {
    return this.#client.connected;
  }

  /** 每次音量表事件给出全部输入的读数。 */
  onLevels(listener: (levels: MeterLevel[]) => void): () => void {
    return this.#client.onEvent((type, data) => {
      if (type !== 'InputVolumeMeters') return;
      const inputs = Array.isArray(data.inputs) ? data.inputs : [];
      listener(
        inputs.flatMap((input) => {
          const { inputName, inputLevelsMul } = (input ?? {}) as {
            inputName?: unknown;
            inputLevelsMul?: unknown;
          };
          if (typeof inputName !== 'string' || !Array.isArray(inputLevelsMul)) return [];
          let peak = 0;
          for (const channel of inputLevelsMul) {
            const value = Array.isArray(channel) ? channel[2] : undefined;
            if (typeof value === 'number' && Number.isFinite(value)) peak = Math.max(peak, value);
          }
          return [{ inputName, peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity }];
        }),
      );
    });
  }

  /** 输入的音频同步偏移（毫秒，GetInputAudioSyncOffset）；读不出时为 null。 */
  async audioSyncOffset(inputName: string): Promise<number | null> {
    const result = await this.#client.request('GetInputAudioSyncOffset', { inputName });
    const value = result.ok ? result.data?.inputAudioSyncOffset : undefined;
    return typeof value === 'number' ? value : null;
  }

  onClose(listener: (reason: string) => void): () => void {
    return this.#client.onClose(listener);
  }

  close(): void {
    this.#client.close();
  }
}
