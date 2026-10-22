import {
  ClockService,
  definePlugin,
  egressAllowed,
  egressPermission,
  SecretsService,
  secretPermission,
} from '@bellis/kernel';
import { type Iris, IrisError, IrisHealth, IrisService } from '@bellis/memory';
import Type, { type Static } from 'typebox';
import { IrisClient } from './client.ts';

/** Iris 的缺省地址：本机 Docker，端口只映射到 127.0.0.1（D-23）。清单按这个主机申请外发。 */
export const IRIS_DEFAULT_URL = 'http://127.0.0.1:8080';
/** 凭据条目：Iris 的宿主令牌。 */
export const IRIS_SECRET = 'iris';

/** 本机回环地址：只有这些主机可以不加密（Iris 容器模式不提供 TLS）。 */
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

export const IrisClientConfig = Type.Object({
  /** Iris 的地址（不含 `/api/v1`）；本机回环可以是 http://，其余须为 https://，主机须已授予外发。 */
  baseUrl: Type.String({ default: IRIS_DEFAULT_URL }),
  /**
   * 维护者已核对 Iris 的外发配置：Iris 自己会把收到的原文发给它配置的模型服务，维护者确认那些服务与端点符合
   * Bellis 的外发与合规要求（合规“Iris 外发”：模型服务的备案、数据出境与留存）。不是 true 时插件不激活，
   * 不向 Iris 发任何请求。
   */
  egressReviewed: Type.Boolean({ default: false }),
  /** 每个请求的截止时间；召回另由调用方给更短的截止时间。 */
  requestTimeoutMs: Type.Integer({ minimum: 1, default: 10_000 }),
  /** 返回体至多读这么多字节。 */
  maxResponseBytes: Type.Integer({ minimum: 1024, default: 2 * 1024 * 1024 }),
  /** 连续失败达到这么多次就报告未就绪（直到下一次成功）；鉴权或权限失败一次就未就绪。 */
  unreadyAfter: Type.Integer({ minimum: 1, default: 3 }),
});
export type IrisClientConfig = Static<typeof IrisClientConfig>;

/** 地址为什么不能连；能连时返回 undefined。 */
export function baseUrlBlocker(
  baseUrl: string,
  permissions: ReadonlySet<string>,
): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return 'Iris 地址不合法';
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    return 'Iris 地址须为 https://（本机回环除外）';
  }
  if (url.username !== '' || url.password !== '') return 'Iris 地址不能带用户名与密码';
  if (url.search !== '' || url.hash !== '') return 'Iris 地址不能带查询或片段';
  if (url.pathname !== '/' && url.pathname !== '')
    return 'Iris 地址不含路径（客户端自己加 /api/v1）';
  if (!egressAllowed(url.hostname, permissions)) {
    return `未授予权限 ${egressPermission(url.hostname)}`;
  }
  return undefined;
}

const HINT = '维护者用 pnpm secret set iris 录入 Iris 的宿主令牌';

/**
 * Iris 客户端（R-19），提供 `iris@1`：按宿主接口契约自写的 HTTP 薄客户端（见 client.ts）。
 * 只负责收发的接入插件：只持有 `secret:iris` 与外发许可 `net.egress:127.0.0.1`（即使是本机回环也要授予）；
 * 收发的内容只当数据转交。隐私网关、墓碑与召回过滤在记忆插件里，它不持凭据。
 *
 * - 激活时核对：维护者已确认 Iris 的外发配置（`egressReviewed`）、地址合规且主机已授予外发、令牌已录入；
 *   任何一项不满足就以说明原因的错误失败，不发任何请求。
 * - 不做隐式重试；失败归类后交给调用方。令牌只用于请求头，不写日志、不进事件与错误说明。
 * - 就绪报告只看最近的请求，不为它发请求（见 `IrisHealth`）。
 */
export const irisClient = definePlugin({
  manifest: {
    id: 'iris-client',
    version: '0.1.0',
    tier: 'ordinary',
    provides: [IrisService.ref],
    inject: [ClockService.ref, SecretsService.ref],
    permissions: [
      egressPermission(new URL(IRIS_DEFAULT_URL).hostname),
      secretPermission(IRIS_SECRET),
    ],
    process: 'in-process',
    config: IrisClientConfig,
  },
  async activate(ctx) {
    const config = ctx.config;
    const fail = (reason: string): never => {
      ctx.log('iris.unavailable', { reason });
      throw new Error(`Iris 客户端不可用：${reason}`);
    };
    if (config.egressReviewed !== true) {
      fail('维护者还没有确认 Iris 的外发配置已核对（egressReviewed 不为 true）');
    }
    const blocked = baseUrlBlocker(config.baseUrl, ctx.permissions);
    if (blocked) fail(blocked);
    let token: string | undefined;
    try {
      token = (await ctx.service(SecretsService).read(IRIS_SECRET))?.trim();
    } catch (error) {
      fail(`读取凭据 ${IRIS_SECRET} 失败：${error instanceof Error ? error.message : error}`);
    }
    if (!token) return fail(`缺少凭据 ${IRIS_SECRET}（${HINT}）`);
    const clock = ctx.service(ClockService);
    const client = new IrisClient({
      baseUrl: config.baseUrl,
      token,
      clock,
      requestTimeoutMs: config.requestTimeoutMs,
      maxResponseBytes: config.maxResponseBytes,
    });
    const health = new IrisHealth(config.unreadyAfter);

    /** 只记类别、HTTP 状态与错误码；取消不记。 */
    const tracked = async <T>(operation: string, work: () => Promise<T>): Promise<T> => {
      try {
        const value = await work();
        health.succeeded();
        return value;
      } catch (error) {
        const failure =
          error instanceof IrisError ? error : new IrisError('protocol', '返回不合约定');
        health.failed(failure);
        if (failure.kind !== 'aborted') {
          ctx.log('iris.failed', {
            operation,
            kind: failure.kind,
            ...(failure.status === undefined ? {} : { status: failure.status }),
            ...(failure.code === undefined ? {} : { code: failure.code }),
          });
        }
        throw failure;
      }
    };
    const any = (signal: AbortSignal) => AbortSignal.any([signal, ctx.signal]);

    const iris: Iris = {
      write: (entryId, messages, signal) =>
        tracked('write', () => client.writeMessages(entryId, messages, any(signal))),
      prepare: (entryId, request, signal) =>
        tracked('prepare', () => client.prepare(entryId, request, any(signal))),
      feedback: (recallId, memoryIds, signal) =>
        tracked('feedback', () => client.feedback(recallId, memoryIds, any(signal))),
      check: (signal) =>
        tracked('status', async () => {
          const status = await client.status(any(signal));
          return { service: status.service };
        }),
      get ready() {
        return health.ready && !ctx.signal.aborted;
      },
      get status() {
        return health.status;
      },
      get failures() {
        return health.failures;
      },
    };
    ctx.provide(IrisService, iris);
  },
});
