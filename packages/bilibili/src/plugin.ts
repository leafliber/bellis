import { type Danmaku, type DanmakuGap, DanmakuService, receiveSpan } from '@bellis/audience';
import {
  ClockService,
  definePlugin,
  egressPermission,
  type PluginSecrets,
  SecretsService,
  secretPermission,
} from '@bellis/kernel';
import { SafetyService } from '@bellis/safety';
import { TelemetryService, traceRef, useTracer } from '@bellis/telemetry';
import Type, { type Static } from 'typebox';
import { OPEN_LIVE_ENDPOINT, OpenApi } from './api.ts';
import { BilibiliClient, type ClientSink, type ClientTimings } from './client.ts';
import { FactType, Intake, type IntakeKind, PLATFORM } from './intake.ts';
import type { Credentials } from './sign.ts';
import { endpointBlocker } from './targets.ts';

/** 凭据条目：访问密钥（JSON）与主播身份码。 */
export const BILIBILI_SECRET = 'bilibili';
export const BILIBILI_CODE_SECRET = 'bilibili-code';
/** 长连接地址的主机都在这个域名下（PENDING：以真机返回的 wss_link 为准）。 */
export const LINK_HOSTS = '*.chat.bilibili.com';

const DAY_MS = 24 * 60 * 60 * 1000;

export const BilibiliConfig = Type.Object({
  /** 开放平台的项目 ID（app_id）；0 表示未配置。 */
  appId: Type.Integer({ minimum: 0, default: 0 }),
  /** 接口基址；改用别的主机须另行授予 `net.egress:<主机>`。 */
  endpoint: Type.String({ default: OPEN_LIVE_ENDPOINT }),
  httpTimeoutMs: Type.Integer({ minimum: 1, default: 5000 }),
  projectHeartbeatMs: Type.Integer({ minimum: 1, default: 20_000 }),
  projectHeartbeatFailures: Type.Integer({ minimum: 1, default: 2 }),
  connectTimeoutMs: Type.Integer({ minimum: 1, default: 5000 }),
  authTimeoutMs: Type.Integer({ minimum: 1, default: 5000 }),
  heartbeatIntervalMs: Type.Integer({ minimum: 1, default: 20_000 }),
  idleTimeoutMs: Type.Integer({ minimum: 1, default: 45_000 }),
  maxSessionAgeMs: Type.Integer({ minimum: 1, maximum: 7 * DAY_MS, default: 6 * DAY_MS }),
  backoffInitialMs: Type.Integer({ minimum: 1, default: 1000 }),
  backoffMaxMs: Type.Integer({ minimum: 1, default: 60_000 }),
  stableAfterMs: Type.Integer({ minimum: 0, default: 60_000 }),
  settlingRetryMs: Type.Integer({ minimum: 1, default: 10_000 }),
  occupiedRetryMs: Type.Integer({ minimum: 1, default: 65_000 }),
  blockedRetryMs: Type.Integer({ minimum: 1, default: 300_000 }),
  endTimeoutMs: Type.Integer({ minimum: 1, default: 3000 }),
  maxPayloadBytes: Type.Integer({ minimum: 1024, default: 4 * 1024 * 1024 }),
  /** 按平台消息编号去重时记得的条数。 */
  dedupCapacity: Type.Integer({ minimum: 1, default: 10_000 }),
});
export type BilibiliConfig = Static<typeof BilibiliConfig>;

/** 配置为什么不能用（不连接任何端点就能判断的部分）；能用时返回 undefined。 */
export function configBlocker(
  config: BilibiliConfig,
  permissions: ReadonlySet<string>,
): string | undefined {
  if (config.appId <= 0) return '未配置项目 ID（appId）';
  const endpoint = endpointBlocker(config.endpoint, permissions);
  if (endpoint) return `接口基址${endpoint}`;
  return undefined;
}

export function timings(config: BilibiliConfig): ClientTimings {
  const {
    httpTimeoutMs,
    projectHeartbeatMs,
    projectHeartbeatFailures,
    connectTimeoutMs,
    authTimeoutMs,
    heartbeatIntervalMs,
    idleTimeoutMs,
    maxSessionAgeMs,
    backoffInitialMs,
    backoffMaxMs,
    stableAfterMs,
    settlingRetryMs,
    occupiedRetryMs,
    blockedRetryMs,
    endTimeoutMs,
    maxPayloadBytes,
  } = config;
  return {
    httpTimeoutMs,
    projectHeartbeatMs,
    projectHeartbeatFailures,
    connectTimeoutMs,
    authTimeoutMs,
    heartbeatIntervalMs,
    idleTimeoutMs,
    maxSessionAgeMs,
    backoffInitialMs,
    backoffMaxMs,
    stableAfterMs,
    settlingRetryMs,
    occupiedRetryMs,
    blockedRetryMs,
    endTimeoutMs,
    maxPayloadBytes,
  };
}

function hint(name: string): string {
  return name === BILIBILI_SECRET
    ? `维护者用 pnpm secret set ${name} 录入 {"accessKeyId": "…", "accessKeySecret": "…"}`
    : `维护者用 pnpm secret set ${name} 录入主播身份码`;
}

async function readSecret(secrets: PluginSecrets, name: string): Promise<string> {
  let value: string | undefined;
  try {
    value = await secrets.read(name);
  } catch (error) {
    throw new Error(`读取凭据 ${name} 失败：${error instanceof Error ? error.message : error}`);
  }
  if (value === undefined || value.trim() === '')
    throw new Error(`缺少凭据 ${name}（${hint(name)}）`);
  return value.trim();
}

/** 读访问密钥：JSON `{"accessKeyId": "…", "accessKeySecret": "…"}`。出错时的说明不含凭据的值。 */
export async function readCredentials(secrets: PluginSecrets): Promise<Credentials> {
  const raw = await readSecret(secrets, BILIBILI_SECRET);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // JSON.parse 的错误说明会摘录原文，不能带出去。
    throw new Error(`凭据 ${BILIBILI_SECRET} 不是 JSON（${hint(BILIBILI_SECRET)}）`);
  }
  const { accessKeyId, accessKeySecret } = (parsed ?? {}) as Record<string, unknown>;
  if (
    typeof accessKeyId !== 'string' ||
    accessKeyId === '' ||
    typeof accessKeySecret !== 'string' ||
    accessKeySecret === ''
  ) {
    throw new Error(
      `凭据 ${BILIBILI_SECRET} 缺少 accessKeyId 或 accessKeySecret（${hint(BILIBILI_SECRET)}）`,
    );
  }
  return { accessKeyId, accessKeySecret };
}

/** 读主播身份码。 */
export function readIdentityCode(secrets: PluginSecrets): Promise<string> {
  return readSecret(secrets, BILIBILI_CODE_SECRET);
}

const instances = new WeakMap<object, () => Promise<void>>();

/**
 * B 站直播开放平台的弹幕接入（R-18），提供 `danmaku@1`。只负责收发：持有 `secret:bilibili` 与
 * `secret:bilibili-code`，外发只到开放平台的接口与长连接主机；收到的内容只当数据转交，不当指令解析。
 * 分诊在 `audience-triage` 里，不持凭据。
 *
 * - 激活时核对配置与凭据（缺了就以说明原因的错误失败，不连接任何端点），然后在后台开启场次与长连接，不阻塞激活。
 * - 普通弹幕写成 `danmaku.received` 后交给订阅者；表情包弹幕、礼物、SC、SC 删除、大航海、点赞、开播、下播
 *   只写事实（见 {@link Intake}）。缺口写 `danmaku.gap-started` 与 `danmaku.gap-ended`。
 * - 停用（含 QUIESCING）时停心跳、关长连接、关闭场次，都带截止时间，失败只记日志。
 * - 就绪报告（开播预检与操作员状态用）：场次已开启、长连接已认证、正在接收时就绪；否则状态说明给出在做什么、
 *   在等什么及原因、还要等多久，缺口的开始时刻随 `gap()` 给出。
 * - 日志不写弹幕正文、昵称、头像、auth_body、签名、身份码与密钥，只写编号、计数、状态与原因。
 * - 遥测在场时，每条交给分诊的弹幕开一个根 span（链路起点，只记平台与消息编号），随弹幕交给下游。
 */
export const danmakuBilibili = definePlugin({
  manifest: {
    id: 'danmaku-bilibili',
    version: '0.1.0',
    tier: 'ordinary',
    provides: [DanmakuService.ref],
    inject: [ClockService.ref, SafetyService.ref, SecretsService.ref, `${TelemetryService.ref}?`],
    permissions: [
      egressPermission(new URL(OPEN_LIVE_ENDPOINT).hostname),
      egressPermission(LINK_HOSTS),
      secretPermission(BILIBILI_SECRET),
      secretPermission(BILIBILI_CODE_SECRET),
    ],
    process: 'in-process',
    config: BilibiliConfig,
  },
  async activate(ctx) {
    const config = ctx.config;
    const blocker = configBlocker(config, ctx.permissions);
    if (blocker) {
      ctx.log('bilibili.unavailable', { reason: blocker });
      throw new Error(`B 站弹幕接入不可用：${blocker}`);
    }
    const clock = ctx.service(ClockService);
    const safety = ctx.service(SafetyService);
    const secrets = ctx.service(SecretsService);
    let credentials: Credentials;
    let code: string;
    try {
      credentials = await readCredentials(secrets);
      code = await readIdentityCode(secrets);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.log('bilibili.unavailable', { reason });
      throw new Error(`B 站弹幕接入不可用：${reason}`);
    }

    const tracer = useTracer(ctx, 'danmaku-bilibili');
    const intake = new Intake(config.dedupCapacity);
    const listeners = new Set<(danmaku: Danmaku) => void>();
    const gapListeners = new Set<(gap: DanmakuGap | undefined) => void>();
    let gap: DanmakuGap | undefined;
    const notifyGap = (next: DanmakuGap | undefined) => {
      gap = next;
      for (const listener of [...gapListeners]) {
        try {
          listener(next);
        } catch (error) {
          ctx.log('bilibili.listener-failed', {
            gap: next !== undefined,
            error: error instanceof Error ? error.name : '未知',
          });
        }
      }
    };
    const counts = new Map<IntakeKind, number>();
    const unknown = new Set<string>();
    const deliver = (danmaku: Danmaku) => {
      for (const listener of [...listeners]) {
        try {
          listener(danmaku);
        } catch (error) {
          ctx.log('bilibili.listener-failed', {
            msgId: danmaku.id,
            error: error instanceof Error ? error.name : '未知',
          });
        }
      }
    };
    const sink: ClientSink = {
      command(command, receivedAt) {
        const result = intake.accept(command, receivedAt);
        counts.set(result.kind, (counts.get(result.kind) ?? 0) + 1);
        if (result.kind === 'unknown' && !unknown.has(command.cmd) && unknown.size < 64) {
          unknown.add(command.cmd);
          ctx.log('bilibili.unknown-command', { cmd: command.cmd.slice(0, 64) });
        } else if (result.kind === 'malformed') {
          ctx.log('bilibili.malformed', { cmd: command.cmd.slice(0, 64), reason: '缺少必需字段' });
        }
        // 交给分诊的弹幕：开链路的根 span（只记平台与消息编号），写成事实、交出之后结束。
        const span = result.danmaku ? receiveSpan(tracer, PLATFORM, result.danmaku.id) : undefined;
        if (result.fact) safety.record(result.fact.type, result.fact.data);
        if (result.danmaku && span) {
          const trace = traceRef(span, clock.now());
          deliver(trace ? { ...result.danmaku, trace } : result.danmaku);
          span.end();
        }
      },
      gapStarted(started) {
        safety.record(FactType.GapStarted, { platform: PLATFORM, ...started });
        notifyGap({ reason: started.reason, startedAt: started.startedAt });
      },
      gapEnded(ended) {
        safety.record(FactType.GapEnded, { platform: PLATFORM, ...ended });
        notifyGap(undefined);
      },
    };
    const api = new OpenApi({
      endpoint: config.endpoint,
      credentials,
      clock,
      wallNow: Date.now,
      timeoutMs: config.httpTimeoutMs,
    });
    api.redact(code);
    const client = new BilibiliClient({
      ...timings(config),
      api,
      appId: config.appId,
      code,
      permissions: ctx.permissions,
      clock,
      wallNow: Date.now,
      log: (event, fields) => ctx.log(event, fields),
      sink,
    });
    let stopped: Promise<void> | undefined;
    const stop = () => {
      stopped ??= client.stop().then(() => {
        ctx.log('bilibili.stopped', { counts: Object.fromEntries(counts) });
      });
      return stopped;
    };
    instances.set(ctx, stop);
    ctx.register(stop);
    ctx.provide(DanmakuService, {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      gap: () => gap,
      onGap(listener) {
        gapListeners.add(listener);
        return () => gapListeners.delete(listener);
      },
      // 就绪：场次已开启、长连接已认证、正在接收（停用中不算）。
      get ready() {
        return client.receiving && !ctx.signal.aborted;
      },
      get status() {
        return client.status;
      },
    });
    client.start();
  },
  async quiesce(ctx) {
    await instances.get(ctx)?.();
  },
});
