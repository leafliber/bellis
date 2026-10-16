import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';
import {
  AuthenticationFailed,
  authenticationString,
  type Message,
  OpCode,
  RequestStatus,
  SUBPROTOCOL,
} from './protocol.ts';

export interface SimObsOptions {
  password?: string;
  scenes?: readonly string[];
  inputs?: readonly string[];
  initialScene?: string;
}

/** 单条消息上限；模拟 OBS 只收很小的请求。 */
const MAX_PAYLOAD_BYTES = 64 * 1024;

interface Handled {
  code: number;
  data?: Record<string, unknown>;
  comment?: string;
}

/**
 * 模拟 OBS：在本机端口上说 obs-websocket 5（JSON 子协议）的一个子集，供 `sim` profile 与测试使用。
 * 场景、输入静音和推流状态都在内存里，可以直接查看。
 */
export class SimObs {
  readonly scenes: readonly string[];
  readonly muted = new Map<string, boolean>();
  /** 各输入的设置（例如浏览器源的 url）。 */
  readonly inputSettings = new Map<string, Record<string, unknown>>();
  currentScene: string;
  streaming = false;
  /** 收到的全部请求，按顺序记录。 */
  readonly requests: Array<{ requestType: string; requestData: Record<string, unknown> }> = [];
  /** 为 true 时所有请求都以失败应答，模拟 OBS 出错。 */
  failing = false;
  readonly #password: string | undefined;
  readonly #connections = new Set<WebSocket>();
  readonly #server: WebSocketServer;

  private constructor(options: SimObsOptions) {
    this.scenes = options.scenes ?? ['Live', 'Safe'];
    this.currentScene = options.initialScene ?? this.scenes[0] ?? '';
    for (const input of options.inputs ?? ['Stage']) {
      this.muted.set(input, false);
      this.inputSettings.set(input, {});
    }
    this.#password = options.password;
    this.#server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      maxPayload: MAX_PAYLOAD_BYTES,
      handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
    });
    this.#server.on('connection', (connection) => this.#accept(connection));
  }

  static async start(options: SimObsOptions = {}): Promise<SimObs> {
    const obs = new SimObs(options);
    await once(obs.#server, 'listening');
    return obs;
  }

  get url(): string {
    const { port } = this.#server.address() as AddressInfo;
    return `ws://127.0.0.1:${port}`;
  }

  /** 断开所有客户端，模拟 OBS 重启或网络中断。 */
  disconnectAll(): void {
    for (const connection of this.#connections) connection.terminate();
  }

  async close(): Promise<void> {
    this.disconnectAll();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #accept(connection: WebSocket): void {
    this.#connections.add(connection);
    connection.on('close', () => this.#connections.delete(connection));
    const challenge = randomBytes(32).toString('base64');
    const salt = randomBytes(32).toString('base64');
    let identified = false;
    connection.send(
      JSON.stringify({
        op: OpCode.Hello,
        d: {
          obsWebSocketVersion: '5.5.0',
          rpcVersion: 1,
          ...(this.#password === undefined ? {} : { authentication: { challenge, salt } }),
        },
      }),
    );
    connection.on('message', (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(String(data)) as Message;
      if (!identified) {
        if (message.op !== OpCode.Identify) return;
        const expected =
          this.#password === undefined
            ? undefined
            : authenticationString(this.#password, salt, challenge);
        if (expected !== undefined && message.d.authentication !== expected) {
          connection.close(AuthenticationFailed, 'Authentication failed.');
          return;
        }
        identified = true;
        connection.send(JSON.stringify({ op: OpCode.Identified, d: { negotiatedRpcVersion: 1 } }));
        return;
      }
      if (message.op === OpCode.Request) {
        const { requestType, requestId, requestData } = message.d as {
          requestType: string;
          requestId: string;
          requestData?: Record<string, unknown>;
        };
        const handled = this.#handle(requestType, requestData ?? {});
        connection.send(
          JSON.stringify({
            op: OpCode.RequestResponse,
            d: response(requestType, requestId, handled),
          }),
        );
      } else if (message.op === OpCode.RequestBatch) {
        const { requestId, requests, haltOnFailure } = message.d as {
          requestId: string;
          haltOnFailure?: boolean;
          requests: Array<{
            requestType: string;
            requestId?: string;
            requestData?: Record<string, unknown>;
          }>;
        };
        const results = [];
        for (const request of requests) {
          const handled = this.#handle(request.requestType, request.requestData ?? {});
          results.push(response(request.requestType, request.requestId, handled));
          if (haltOnFailure && handled.code !== RequestStatus.Success) break;
        }
        connection.send(
          JSON.stringify({ op: OpCode.RequestBatchResponse, d: { requestId, results } }),
        );
      }
    });
  }

  #handle(requestType: string, data: Record<string, unknown>): Handled {
    this.requests.push({ requestType, requestData: data });
    if (this.failing) return { code: 702, comment: '模拟 OBS 故障' };
    switch (requestType) {
      case 'GetCurrentProgramScene':
        return {
          code: RequestStatus.Success,
          data: { currentProgramSceneName: this.currentScene, sceneName: this.currentScene },
        };
      case 'SetCurrentProgramScene': {
        const scene = String(data.sceneName);
        if (!this.scenes.includes(scene))
          return { code: RequestStatus.ResourceNotFound, comment: `没有场景 ${scene}` };
        this.currentScene = scene;
        return { code: RequestStatus.Success };
      }
      case 'GetInputMute': {
        const input = String(data.inputName);
        if (!this.muted.has(input))
          return { code: RequestStatus.ResourceNotFound, comment: `没有输入 ${input}` };
        return { code: RequestStatus.Success, data: { inputMuted: this.muted.get(input) } };
      }
      case 'SetInputMute': {
        const input = String(data.inputName);
        if (!this.muted.has(input))
          return { code: RequestStatus.ResourceNotFound, comment: `没有输入 ${input}` };
        this.muted.set(input, data.inputMuted === true);
        return { code: RequestStatus.Success };
      }
      case 'GetInputSettings': {
        const input = String(data.inputName);
        const settings = this.inputSettings.get(input);
        if (!settings)
          return { code: RequestStatus.ResourceNotFound, comment: `没有输入 ${input}` };
        return {
          code: RequestStatus.Success,
          data: { inputSettings: { ...settings }, inputKind: 'browser_source' },
        };
      }
      case 'SetInputSettings': {
        const input = String(data.inputName);
        const settings = this.inputSettings.get(input);
        if (!settings)
          return { code: RequestStatus.ResourceNotFound, comment: `没有输入 ${input}` };
        const next = (data.inputSettings ?? {}) as Record<string, unknown>;
        this.inputSettings.set(
          input,
          data.overlay === false ? { ...next } : { ...settings, ...next },
        );
        return { code: RequestStatus.Success };
      }
      case 'GetStreamStatus':
        return { code: RequestStatus.Success, data: { outputActive: this.streaming } };
      case 'StartStream':
        if (this.streaming) return { code: RequestStatus.OutputRunning };
        this.streaming = true;
        return { code: RequestStatus.Success };
      case 'StopStream':
        if (!this.streaming) return { code: RequestStatus.OutputNotRunning };
        this.streaming = false;
        return { code: RequestStatus.Success };
      default:
        return { code: RequestStatus.UnknownRequestType };
    }
  }
}

function response(requestType: string, requestId: string | undefined, handled: Handled) {
  return {
    requestType,
    ...(requestId === undefined ? {} : { requestId }),
    requestStatus: {
      result: handled.code === RequestStatus.Success,
      code: handled.code,
      ...(handled.comment === undefined ? {} : { comment: handled.comment }),
    },
    ...(handled.data === undefined ? {} : { responseData: handled.data }),
  };
}
