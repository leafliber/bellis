/**
 * 订阅 obs-websocket 的 InputVolumeMeters（约每 50ms 一次），给出每个输入的峰值（dBFS）。
 * 用来判断 Stage 的声音是否只经浏览器源进入 OBS：开启“Control audio via OBS”后，
 * 测试音应只出现在浏览器源上，不应出现在采集系统声音的输入（如桌面音频）上。
 * 现有的 ObsClient 不订阅事件，这里为探针单独连一条。
 */
import { authenticationString, OpCode, SUBPROTOCOL } from '@bellis/obs';

const INPUT_VOLUME_METERS = 1 << 16;

export interface MeterReading {
  name: string;
  /** 各声道峰值的最大值；无声为 -Infinity。 */
  peakDb: number;
}

export class ObsMeters {
  readonly #socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
  }

  static connect(
    url: string,
    password: string | undefined,
    onReadings: (readings: MeterReading[]) => void,
  ): Promise<ObsMeters> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, SUBPROTOCOL);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('连接 OBS 音量表超时'));
      }, 3000);
      socket.addEventListener('error', () => reject(new Error('无法连接 OBS 音量表')));
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as {
          op: number;
          d: Record<string, unknown>;
        };
        if (message.op === OpCode.Hello) {
          const auth = message.d.authentication as { salt: string; challenge: string } | undefined;
          socket.send(
            JSON.stringify({
              op: OpCode.Identify,
              d: {
                rpcVersion: 1,
                eventSubscriptions: INPUT_VOLUME_METERS,
                ...(auth && password !== undefined
                  ? { authentication: authenticationString(password, auth.salt, auth.challenge) }
                  : {}),
              },
            }),
          );
        } else if (message.op === OpCode.Identified) {
          clearTimeout(timer);
          resolve(new ObsMeters(socket));
        } else if (message.op === OpCode.Event && message.d.eventType === 'InputVolumeMeters') {
          const data = message.d.eventData as {
            inputs: Array<{ inputName: string; inputLevelsMul: number[][] }>;
          };
          onReadings(
            data.inputs.map((input) => {
              // 每个声道是 [magnitude, peak, inputPeak]，取推子后的 peak。
              const peak = Math.max(0, ...input.inputLevelsMul.map((levels) => levels[1] ?? 0));
              return {
                name: input.inputName,
                peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
              };
            }),
          );
        }
      });
    });
  }

  close(): void {
    this.#socket.close();
  }
}
