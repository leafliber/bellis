import { randomUUID } from 'node:crypto';
import type { Clock } from '@bellis/kernel';
import { type Credentials, signedHeaders } from './sign.ts';

/** 官方的开放平台接口基址。清单按这个主机申请外发权限；改用别的基址须另行授予该主机。 */
export const OPEN_LIVE_ENDPOINT = 'https://live-open.biliapi.com';

/** 平台错误码中本插件按含义处理的几个（见观众接入文档）。 */
export const ErrorCode = {
  /** nonce 重复：换一个 nonce 稍后重试。 */
  NonceRepeated: 4004,
  /** IP 不在白名单。 */
  IpWhitelist: 4007,
  /** 访问受限。 */
  AccessLimited: 4009,
  /** 未上架的应用只能连开发者自己的直播间。 */
  RoomWhitelist: 5004,
  RoomWhitelist2: 5011,
  /** 不在场次中（关闭时视为已关闭）。 */
  NotInGame: 7000,
  /** 上一局还在结算，约 10 秒后重试。 */
  Settling: 7001,
  /** 直播间已有场次，或上一场没有正常结束：等 1 分钟以上再开。 */
  Occupied: 7002,
  /** 心跳过期或场次已关闭：重新开启。 */
  GameExpired: 7003,
  /** 连接数超限。 */
  TooManyConnections: 7010,
} as const;

/**
 * 接口失败。`code` 为平台返回体里的错误码；网络错误、超时、HTTP 状态不是 200、返回体不合法时为 undefined。
 * `message` 不含凭据（平台给的说明已抹去请求里的凭据并截短）。
 */
export class ApiError extends Error {
  readonly code: number | undefined;
  readonly requestId: string | undefined;

  constructor(message: string, code?: number, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.requestId = requestId;
  }
}

/** 开启场次的结果。`authBody` 是长连接认证用的凭据，不写日志。 */
export interface GameSession {
  gameId: string;
  authBody: string;
  links: string[];
  roomId: number | undefined;
}

export interface OpenApiOptions {
  /** 接口基址，例如 {@link OPEN_LIVE_ENDPOINT}。 */
  endpoint: string;
  credentials: Credentials;
  clock: Clock;
  /** 墙钟（毫秒）：签名时间戳。 */
  wallNow: () => number;
  timeoutMs: number;
  /** 测试用：替换 nonce 的生成。 */
  nonce?: () => string;
}

const MAX_BODY_CHARS = 1024 * 1024;

/** 抹掉文本里出现的凭据并截短：平台给的错误说明只在这样处理后才写进错误。 */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text.replace(/\s+/g, ' ').trim();
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join('***');
  return out.length > 200 ? `${out.slice(0, 200)}…` : out;
}

function message(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // fetch 把底层原因（拒绝连接、DNS 失败等）放在 cause 里。
  const cause = error.cause instanceof Error ? `（${error.cause.message}）` : '';
  return `${error.message}${cause}`;
}

/**
 * B 站直播开放平台的 HTTP 接口：一律 POST JSON，按签名鉴权签名；HTTP 状态恒为 200，成败看返回体的 `code`，
 * 0 为成功。不做隐式重试，重试与等待由调用方按错误码决定。
 */
export class OpenApi {
  readonly #options: OpenApiOptions;
  readonly #base: string;
  readonly #secrets: string[];

  constructor(options: OpenApiOptions) {
    this.#options = options;
    this.#base = options.endpoint.replace(/\/+$/, '');
    this.#secrets = [options.credentials.accessKeyId, options.credentials.accessKeySecret];
  }

  /** 额外需要从错误说明里抹掉的值（例如身份码）。 */
  redact(...values: string[]): void {
    this.#secrets.push(...values);
  }

  async call(
    path: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs = this.#options.timeoutMs,
  ): Promise<unknown> {
    const { clock } = this.#options;
    const body = JSON.stringify(payload);
    const headers = signedHeaders(
      body,
      this.#options.credentials,
      Math.floor(this.#options.wallNow() / 1000),
      this.#options.nonce?.() ?? randomUUID(),
    );
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted) throw new ApiError('已取消');
    signal.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = clock.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let text: string;
    try {
      const response = await fetch(`${this.#base}${path}`, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
        redirect: 'error',
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        throw new ApiError(`HTTP ${response.status}`);
      }
      text = await response.text();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (timedOut) throw new ApiError(`请求未在 ${timeoutMs}ms 内完成`);
      if (signal.aborted) throw new ApiError('已取消');
      throw new ApiError(`请求失败：${scrub(message(error), this.#secrets)}`);
    } finally {
      clock.clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
    if (text.length > MAX_BODY_CHARS) throw new ApiError('返回体过大');
    let parsed: { code?: unknown; message?: unknown; request_id?: unknown; data?: unknown };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new ApiError('返回体不是 JSON');
    }
    if (typeof parsed !== 'object' || parsed === null) throw new ApiError('返回体不是对象');
    const requestId = typeof parsed.request_id === 'string' ? parsed.request_id : undefined;
    if (typeof parsed.code !== 'number')
      throw new ApiError('返回体缺少 code', undefined, requestId);
    if (parsed.code !== 0) {
      const said = typeof parsed.message === 'string' ? scrub(parsed.message, this.#secrets) : '';
      throw new ApiError(
        `平台返回错误 ${parsed.code}${said ? `：${said}` : ''}`,
        parsed.code,
        requestId,
      );
    }
    return parsed.data;
  }

  /** 开启场次（`/v2/app/start`）。`code` 为主播身份码。 */
  async start(code: string, appId: number, signal: AbortSignal): Promise<GameSession> {
    const data = (await this.call('/v2/app/start', { code, app_id: appId }, signal)) as {
      game_info?: { game_id?: unknown };
      websocket_info?: { auth_body?: unknown; wss_link?: unknown };
      anchor_info?: { room_id?: unknown };
    } | null;
    const gameId = data?.game_info?.game_id;
    const authBody = data?.websocket_info?.auth_body;
    const links = data?.websocket_info?.wss_link;
    if (typeof gameId !== 'string') throw new ApiError('开启场次的返回缺少 game_id');
    if (typeof authBody !== 'string' || authBody === '') {
      throw new ApiError('开启场次的返回缺少 auth_body');
    }
    if (!Array.isArray(links) || !links.every((link) => typeof link === 'string')) {
      throw new ApiError('开启场次的返回缺少 wss_link');
    }
    const roomId = data?.anchor_info?.room_id;
    return {
      gameId,
      authBody,
      links: links as string[],
      roomId: typeof roomId === 'number' ? roomId : undefined,
    };
  }

  /** 项目心跳（`/v2/app/heartbeat`）。 */
  async heartbeat(gameId: string, signal: AbortSignal): Promise<void> {
    await this.call('/v2/app/heartbeat', { game_id: gameId }, signal);
  }

  /** 关闭场次（`/v2/app/end`）。场次已不在（7000、7003）时视为已关闭。 */
  async end(appId: number, gameId: string, signal: AbortSignal, timeoutMs?: number): Promise<void> {
    try {
      await this.call('/v2/app/end', { app_id: appId, game_id: gameId }, signal, timeoutMs);
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.code === ErrorCode.NotInGame || error.code === ErrorCode.GameExpired)
      ) {
        return;
      }
      throw error;
    }
  }
}
