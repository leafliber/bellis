import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { brotliCompressSync, deflateSync } from 'node:zlib';
import { type WebSocket, WebSocketServer } from 'ws';
import { decodePackets, encodePacket, Operation, Version } from '../src/index.ts';

/**
 * 本机伪开放平台：只用于测试，不连接任何真实端点。
 *
 * HTTP（`/v2/app/start`、`/v2/app/heartbeat`、`/v2/app/end`）用与客户端同样的签名规则**核验**请求，
 * 但这里是独立实现：六个 `x-bili-*` 头齐全、MD5 与请求体一致、时间戳为秒且与本机相差不超过 10 分钟、
 * nonce 不重复、按键名字典序拼成的待签名串的 HMAC-SHA256 与 Authorization 一致。核验失败用的错误码
 * （4001–4003）是这里自定的，只供测试；nonce 重复用 4004。一个直播间同时只有一个场次：已有场次时开启返回 7002，
 * 心跳或关闭的场次不在时返回 7003 或 7000。可按接口排队注入错误码。
 *
 * 长连接（同一端口）：`/sub` 正常，`/reject` 拒绝升级（HTTP 503），`/silent` 接受连接但从不回认证。
 * 先收认证包（正文须是当前场次的 auth_body），回复 `{"code":0}`；之后回心跳；可推送原文、zlib、brotli 的
 * 批量消息，断开全部连接，推送 `INTERACTION_END`，停止回心跳。
 */
export interface FakePlatformOptions {
  accessKeyId: string;
  accessKeySecret: string;
  code: string;
  appId: number;
  /** 开启场次时返回的长连接地址；缺省为一个本机正常地址。 */
  links?: (fake: FakePlatform) => string[];
  /** 收到认证包后晚这么久再回复。 */
  authReplyDelayMs?: number;
  /** 开启场次的接口晚这么久再返回。 */
  startDelayMs?: number;
  /**
   * 开启场次时 `game_id` 返回空串（社区实现所见的不分场次的项目）：不判“已有场次”，内部仍按认证正文区分
   * 先后开启的连接。
   */
  emptyGameId?: boolean;
}

export type ApiName = 'start' | 'heartbeat' | 'end';

export interface ApiRequest {
  api: ApiName | 'unknown';
  body: Record<string, unknown> | undefined;
  /** 签名核验通过。 */
  verified: boolean;
  /** 返回的 code。 */
  code: number;
  at: number;
}

export interface ReceivedPacket {
  connection: number;
  operation: number;
  version: number;
  body: string;
  at: number;
}

export interface FakeConnection {
  id: number;
  path: string;
  host: string;
  authed: boolean;
  socket: WebSocket;
}

export interface Command {
  cmd: string;
  data: unknown;
}

const SKEW_SECONDS = 600;

/** 伪平台发给客户端的 auth_body 里带的标记：测试据此核对它不出现在日志里。 */
export const AUTH_MARKER = 'AUTH-BODY-SECRET';
export const ANCHOR_NAME = '主播昵称不该进日志';

export class FakePlatform {
  readonly requests: ApiRequest[] = [];
  readonly packets: ReceivedPacket[] = [];
  readonly connections: FakeConnection[] = [];
  /** 全部长连接的升级请求（含被拒的），按到达顺序。 */
  readonly upgrades: Array<{ path: string; host: string }> = [];
  /** 下一次调用各接口时依次返回的错误码。 */
  readonly failNext: Record<ApiName, number[]> = { start: [], heartbeat: [], end: [] };
  /** 认证回复之前收到的其它包。 */
  readonly early: ReceivedPacket[] = [];
  /** 为 true 时不回心跳。 */
  muteHeartbeat = false;
  /** 为 true 时拒绝认证（code -101）。 */
  rejectAuth = false;
  /** 当前场次；没有时为 undefined。 */
  activeGame: string | undefined;
  readonly games: string[] = [];
  readonly #options: FakePlatformOptions;
  readonly #server: Server;
  readonly #wss = new WebSocketServer({ noServer: true });
  readonly #nonces = new Set<string>();
  readonly #authBodies = new Map<string, string>();

  private constructor(options: FakePlatformOptions) {
    this.#options = options;
    this.#server = createServer((request, response) => void this.#http(request, response));
    this.#server.on('upgrade', (request, socket, head) => this.#upgrade(request, socket, head));
  }

  static async start(options: FakePlatformOptions): Promise<FakePlatform> {
    const fake = new FakePlatform(options);
    fake.#server.listen(0, '127.0.0.1');
    await once(fake.#server, 'listening');
    return fake;
  }

  get port(): number {
    return (this.#server.address() as AddressInfo).port;
  }

  get endpoint(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  wsUrl(path = '/sub', host = '127.0.0.1'): string {
    return `ws://${host}:${this.port}${path}`;
  }

  calls(api: ApiName): ApiRequest[] {
    return this.requests.filter((r) => r.api === api);
  }

  /** 已认证的连接。 */
  get authed(): FakeConnection[] {
    return this.connections.filter((c) => c.authed && c.socket.readyState === c.socket.OPEN);
  }

  /** 把一批消息推给全部已认证的连接：原文逐条发，或打包成一条 zlib / brotli 压缩的消息。 */
  push(commands: Command | Command[], compression: 'none' | 'zlib' | 'brotli' = 'none'): void {
    const list = Array.isArray(commands) ? commands : [commands];
    const packets = list.map((c) =>
      encodePacket(Operation.Message, JSON.stringify(c), Version.Raw, 0),
    );
    const frames =
      compression === 'none'
        ? packets
        : [
            encodePacket(
              Operation.Message,
              compression === 'zlib'
                ? deflateSync(Buffer.concat(packets))
                : brotliCompressSync(Buffer.concat(packets)),
              compression === 'zlib' ? Version.Zlib : Version.Brotli,
              0,
            ),
          ];
    for (const connection of this.authed) for (const frame of frames) connection.socket.send(frame);
  }

  /** 场次失效：平台关闭当前场次并推送 INTERACTION_END。 */
  interactionEnd(gameId = this.#options.emptyGameId ? '' : this.activeGame): void {
    this.activeGame = undefined;
    this.push({
      cmd: 'LIVE_OPEN_PLATFORM_INTERACTION_END',
      data: { game_id: gameId, timestamp: 1 },
    });
  }

  /** 平台那边场次过期（例如心跳超时）：之后的心跳返回 7003。 */
  expire(): void {
    this.activeGame = undefined;
  }

  /** 断开全部长连接（模拟网络中断）。 */
  drop(): void {
    for (const connection of this.connections) connection.socket.terminate();
  }

  async close(): Promise<void> {
    for (const connection of this.connections) connection.socket.terminate();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #verify(request: IncomingMessage, body: string): number {
    const o = this.#options;
    const header = (name: string) => {
      const value = request.headers[name];
      return typeof value === 'string' ? value : undefined;
    };
    const signed: Record<string, string> = {};
    for (const name of [
      'x-bili-accesskeyid',
      'x-bili-content-md5',
      'x-bili-signature-method',
      'x-bili-signature-nonce',
      'x-bili-signature-version',
      'x-bili-timestamp',
    ]) {
      const value = header(name);
      if (value === undefined) return 4001;
      signed[name] = value;
    }
    const authorization = header('authorization');
    if (authorization === undefined) return 4001;
    if (header('content-type') !== 'application/json') return 4001;
    if (header('accept') !== 'application/json') return 4001;
    if (signed['x-bili-signature-method'] !== 'HMAC-SHA256') return 4001;
    if (signed['x-bili-signature-version'] !== '1.0') return 4001;
    if (signed['x-bili-accesskeyid'] !== o.accessKeyId) return 4001;
    const md5 = createHash('md5').update(Buffer.from(body, 'utf8')).digest('hex');
    if (signed['x-bili-content-md5'] !== md5) return 4002;
    const timestamp = signed['x-bili-timestamp'] as string;
    if (!/^\d+$/.test(timestamp)) return 4003;
    if (Math.abs(Number(timestamp) - Math.floor(Date.now() / 1000)) > SKEW_SECONDS) return 4003;
    const lines = Object.keys(signed)
      .sort()
      .map((key) => `${key}:${signed[key]}`);
    const expected = createHmac('sha256', o.accessKeySecret).update(lines.join('\n')).digest();
    const given = Buffer.from(authorization, 'hex');
    if (
      !/^[0-9a-f]{64}$/.test(authorization) ||
      given.length !== expected.length ||
      !timingSafeEqual(given, expected)
    ) {
      return 4002;
    }
    const nonce = signed['x-bili-signature-nonce'] as string;
    if (this.#nonces.has(nonce)) return 4004;
    this.#nonces.add(nonce);
    return 0;
  }

  async #http(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const path = request.url ?? '';
    const api: ApiName | 'unknown' =
      path === '/v2/app/start'
        ? 'start'
        : path === '/v2/app/heartbeat'
          ? 'heartbeat'
          : path === '/v2/app/end'
            ? 'end'
            : 'unknown';
    let body: Record<string, unknown> | undefined;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      body = undefined;
    }
    const verify = request.method === 'POST' ? this.#verify(request, raw) : 4001;
    const entry: ApiRequest = { api, body, verified: verify === 0, code: 0, at: Date.now() };
    this.requests.push(entry);
    const reply = (code: number, data: unknown = {}) => {
      entry.code = code;
      // 开放平台的 HTTP 状态恒为 200，成败看 code。
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          code,
          message: code === 0 ? '0' : `fake error ${code}`,
          request_id: `req-${this.requests.length}`,
          data,
        }),
      );
    };
    if (verify !== 0) return reply(verify);
    if (api === 'unknown' || !body) return reply(4000);
    const injected = this.failNext[api].shift();
    if (injected !== undefined) {
      if (api === 'heartbeat' && injected === 7003) this.activeGame = undefined;
      return reply(injected);
    }
    switch (api) {
      case 'start': {
        if (body.code !== this.#options.code || body.app_id !== this.#options.appId) {
          return reply(4000);
        }
        if (this.activeGame !== undefined && !this.#options.emptyGameId) return reply(7002);
        if (this.#options.startDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, this.#options.startDelayMs));
        }
        const gameId = `game-${this.games.length + 1}`;
        const authBody = JSON.stringify({ key: `${AUTH_MARKER}-${gameId}`, group: 'open' });
        this.games.push(gameId);
        this.activeGame = gameId;
        this.#authBodies.set(gameId, authBody);
        const links = this.#options.links?.(this) ?? [this.wsUrl()];
        return reply(0, {
          game_info: { game_id: this.#options.emptyGameId ? '' : gameId },
          websocket_info: { auth_body: authBody, wss_link: links },
          anchor_info: {
            room_id: 1001,
            uname: ANCHOR_NAME,
            uface: 'https://i0.hdslb.com/anchor-face.jpg',
            open_id: 'anchor-open-id',
          },
        });
      }
      case 'heartbeat':
        return reply(body.game_id === this.activeGame && this.activeGame ? 0 : 7003);
      case 'end':
        if (body.app_id !== this.#options.appId) return reply(4000);
        if (body.game_id !== this.activeGame || !this.activeGame) return reply(7000);
        this.activeGame = undefined;
        return reply(0);
    }
  }

  #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = request.url ?? '';
    this.upgrades.push({ path, host: String(request.headers.host ?? '') });
    if (path === '/reject') {
      socket.end(
        'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    this.#wss.handleUpgrade(request, socket, head, (ws) => {
      const connection: FakeConnection = {
        id: this.connections.length + 1,
        path,
        host: String(request.headers.host ?? ''),
        authed: false,
        socket: ws,
      };
      this.connections.push(connection);
      ws.on('message', (data) => this.#receive(connection, data as Buffer));
    });
  }

  #receive(connection: FakeConnection, data: Buffer): void {
    for (const packet of decodePackets(data)) {
      const received: ReceivedPacket = {
        connection: connection.id,
        operation: packet.operation,
        version: packet.version,
        body: packet.body.toString('utf8'),
        at: Date.now(),
      };
      this.packets.push(received);
      if (connection.path === '/silent') continue;
      if (!connection.authed) {
        if (packet.operation !== Operation.Auth) {
          this.early.push(received);
          continue;
        }
        const valid =
          !this.rejectAuth &&
          this.activeGame !== undefined &&
          this.#authBodies.get(this.activeGame) === received.body;
        const reply = () => {
          if (connection.socket.readyState !== connection.socket.OPEN) return;
          connection.authed = valid;
          connection.socket.send(
            encodePacket(Operation.AuthReply, JSON.stringify({ code: valid ? 0 : -101 }), 0, 0),
          );
        };
        if (this.#options.authReplyDelayMs) setTimeout(reply, this.#options.authReplyDelayMs);
        else reply();
        continue;
      }
      if (packet.operation === Operation.Heartbeat && !this.muteHeartbeat) {
        const popularity = Buffer.alloc(4);
        popularity.writeUInt32BE(1);
        connection.socket.send(
          encodePacket(Operation.HeartbeatReply, popularity, Version.Client, 0),
        );
      }
    }
  }
}
