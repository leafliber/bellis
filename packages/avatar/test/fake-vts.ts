import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';
import { VTS_API_NAME, VTS_API_VERSION, VtsErrorId } from '../src/index.ts';

export interface FakeVtsOptions {
  /** 监听的端口；缺省随机。 */
  port?: number;
  /** 视为有效的令牌。 */
  tokens?: readonly string[];
  /** 令牌申请的应答：发放这个令牌；`deny` 以错误 50 拒绝；`hold` 不应答（弹窗没人处理）。 */
  approval?: string;
  /** 已被其他插件占用的参数。 */
  occupied?: readonly string[];
  /** 当前模型的热键 ID。 */
  hotkeys?: readonly string[];
  /** 收到消息时记下的时刻（测试用手动时钟）。 */
  now?: () => number;
}

export interface Received {
  at: number;
  messageType: string;
  data: Record<string, unknown>;
}

interface Session {
  authenticated: boolean;
}

/**
 * 假的 VTube Studio 插件 API：在本机端口上说 VTS 公开 API 的一个子集（令牌申请、认证、注入参数、
 * 触发热键），只用于测试。收到的请求按顺序记录。
 */
export class FakeVts {
  readonly received: Received[] = [];
  readonly tokens: Set<string>;
  approval: string;
  readonly occupied: Set<string>;
  readonly hotkeys: Set<string>;
  readonly #now: () => number;
  readonly #server: WebSocketServer;
  readonly #sockets = new Set<WebSocket>();
  /** 累计接受过的连接数。 */
  accepted = 0;

  private constructor(options: FakeVtsOptions) {
    this.tokens = new Set(options.tokens ?? []);
    this.approval = options.approval ?? 'hold';
    this.occupied = new Set(options.occupied ?? []);
    this.hotkeys = new Set(options.hotkeys ?? []);
    this.#now = options.now ?? Date.now;
    this.#server = new WebSocketServer({ host: '127.0.0.1', port: options.port ?? 0 });
    this.#server.on('connection', (socket) => this.#accept(socket));
  }

  static async start(options: FakeVtsOptions = {}): Promise<FakeVts> {
    const vts = new FakeVts(options);
    await once(vts.#server, 'listening');
    return vts;
  }

  get port(): number {
    return (this.#server.address() as AddressInfo).port;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  /** 某类请求的数据，按收到的顺序。 */
  of(messageType: string): Array<Record<string, unknown>> {
    return this.received.filter((r) => r.messageType === messageType).map((r) => r.data);
  }

  /** 收到的注入请求（每个请求一项，只取第一个参数）。 */
  injections(): Array<{
    at: number;
    id: unknown;
    value: unknown;
    faceFound: unknown;
    mode: unknown;
  }> {
    return this.received
      .filter((r) => r.messageType === 'InjectParameterDataRequest')
      .map((r) => {
        const values = r.data.parameterValues as Array<Record<string, unknown>>;
        return {
          at: r.at,
          id: values[0]?.id,
          value: values[0]?.value,
          faceFound: r.data.faceFound,
          mode: r.data.mode,
        };
      });
  }

  /** 断开全部连接，模拟 VTS 退出或网络中断。 */
  drop(): void {
    for (const socket of this.#sockets) socket.terminate();
  }

  async close(): Promise<void> {
    this.drop();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #accept(socket: WebSocket): void {
    this.accepted += 1;
    this.#sockets.add(socket);
    const session: Session = { authenticated: false };
    socket.on('close', () => this.#sockets.delete(socket));
    socket.on('message', (raw) => this.#handle(socket, session, String(raw)));
  }

  #handle(socket: WebSocket, session: Session, text: string): void {
    const message = JSON.parse(text) as {
      apiName: string;
      apiVersion: string;
      requestID: string;
      messageType: string;
      data?: Record<string, unknown>;
    };
    const data = message.data ?? {};
    this.received.push({ at: this.#now(), messageType: message.messageType, data });
    const reply = (messageType: string, payload: Record<string, unknown>) =>
      socket.send(
        JSON.stringify({
          apiName: VTS_API_NAME,
          apiVersion: VTS_API_VERSION,
          timestamp: Date.now(),
          requestID: message.requestID,
          messageType,
          data: payload,
        }),
      );
    const error = (errorID: number, text: string) => reply('APIError', { errorID, message: text });
    if (message.apiName !== VTS_API_NAME || message.apiVersion !== VTS_API_VERSION) {
      error(2, 'API name or version invalid.');
      return;
    }
    switch (message.messageType) {
      case 'AuthenticationTokenRequest':
        if (this.approval === 'hold') return;
        if (this.approval === 'deny') {
          error(VtsErrorId.TokenRequestDenied, 'User has denied API access for your plugin.');
          return;
        }
        this.tokens.add(this.approval);
        reply('AuthenticationTokenResponse', { authenticationToken: this.approval });
        return;
      case 'AuthenticationRequest': {
        const token = data.authenticationToken;
        session.authenticated =
          typeof token === 'string' &&
          this.tokens.has(token) &&
          typeof data.pluginName === 'string' &&
          typeof data.pluginDeveloper === 'string';
        reply('AuthenticationResponse', {
          authenticated: session.authenticated,
          reason: session.authenticated ? 'Token valid.' : 'Token invalid.',
        });
        return;
      }
    }
    if (!session.authenticated) {
      error(VtsErrorId.RequestRequiresAuthentication, 'This request requires authentication.');
      return;
    }
    switch (message.messageType) {
      case 'InjectParameterDataRequest': {
        const values = (data.parameterValues ?? []) as Array<{ id: string }>;
        const taken = values.find((value) => this.occupied.has(value.id));
        if (taken) {
          error(
            VtsErrorId.InjectDataParamControlledByOtherPlugin,
            `Parameter ${taken.id} is currently controlled by another plugin.`,
          );
          return;
        }
        reply('InjectParameterDataResponse', {});
        return;
      }
      case 'HotkeyTriggerRequest': {
        const id = String(data.hotkeyID);
        if (!this.hotkeys.has(id)) {
          error(202, `Hotkey ${id} not found in model.`);
          return;
        }
        reply('HotkeyTriggerResponse', { hotkeyID: id });
        return;
      }
      default:
        error(1, `Unknown message type ${message.messageType}.`);
    }
  }
}
