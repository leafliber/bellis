import { CandidatesService, type Danmaku, DanmakuService, triage } from '@bellis/audience';
import {
  ClockService,
  catalog,
  Kernel,
  type PluginSecrets,
  RandomService,
  type ResolvedEntry,
  SecretsService,
  type ServiceToken,
  secretPermission,
  systemClock,
  systemRandom,
} from '@bellis/kernel';
import { SafetyCore, SafetyService, safetyFacade } from '@bellis/safety';
import { MemorySecretStore } from '@bellis/secret-store';
import { StateStore } from '@bellis/store';
import { memoryTelemetry } from '@bellis/telemetry';
import { danmakuBilibili } from '../src/index.ts';
import { FakePlatform, type FakePlatformOptions } from './fake-platform.ts';

/** 测试专用的假密钥与身份码：值都带上可辨认的标记，便于核对它们不出现在日志里。 */
export const ACCESS_KEY_ID = 'FAKE-ACCESS-KEY-ID-0001';
export const ACCESS_KEY_SECRET = 'FAKE-ACCESS-KEY-SECRET-0002';
export const IDENTITY_CODE = 'FAKE-IDENTITY-CODE-0003';
export const APP_ID = 1650000000001;

export const SECRETS = {
  bilibili: JSON.stringify({ accessKeyId: ACCESS_KEY_ID, accessKeySecret: ACCESS_KEY_SECRET }),
  'bilibili-code': IDENTITY_CODE,
};

/** 插件需要的全部权限（含本机伪平台的主机）。 */
export const GRANT = [
  'net.egress:live-open.biliapi.com',
  'net.egress:*.chat.bilibili.com',
  'net.egress:127.0.0.1',
  'secret:bilibili',
  'secret:bilibili-code',
];

export function fakePlatform(options: Partial<FakePlatformOptions> = {}): Promise<FakePlatform> {
  return FakePlatform.start({
    accessKeyId: ACCESS_KEY_ID,
    accessKeySecret: ACCESS_KEY_SECRET,
    code: IDENTITY_CODE,
    appId: APP_ID,
    ...options,
  });
}

/** 测试用的短时限：都远小于缺省值，靠等条件而不是固定等待。 */
export function fastConfig(fake: FakePlatform, overrides: Record<string, unknown> = {}) {
  return {
    appId: APP_ID,
    endpoint: fake.endpoint,
    httpTimeoutMs: 2000,
    projectHeartbeatMs: 60_000,
    connectTimeoutMs: 2000,
    authTimeoutMs: 2000,
    heartbeatIntervalMs: 60_000,
    idleTimeoutMs: 60_000,
    backoffInitialMs: 20,
    backoffMaxMs: 200,
    stableAfterMs: 60_000,
    settlingRetryMs: 150,
    occupiedRetryMs: 300,
    blockedRetryMs: 2000,
    endTimeoutMs: 1000,
    ...overrides,
  };
}

export function entry(
  id: string,
  plugin: string,
  extra: Partial<ResolvedEntry> = {},
): ResolvedEntry {
  return { id, plugin, config: {}, disabled: false, explicitSwitch: false, grant: [], ...extra };
}

/** 等条件成立；超时则带上说明失败。 */
export async function waitFor(
  condition: () => boolean,
  what: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * 等接入插件第 `count` 次连上长连接：认证回复已处理、缺口已结束。只看伪平台的 `authed` 不够——
 * 伪平台发出认证回复时就算认证了，客户端那时还没处理。
 */
export function linkReady(
  w: { logged(event: string): unknown[] },
  count = 1,
  timeoutMs = 5000,
): Promise<void> {
  return waitFor(
    () => w.logged('bilibili.link-ready').length >= count,
    `第 ${count} 次连上`,
    timeoutMs,
  );
}

/**
 * 真实时钟下的小世界：状态存储（内存）、安全核（仿真模式）、插件内核，凭据服务按授予的权限放行
 * （与宿主的实现一致），凭据存在内存里。目录里有接入插件与分诊。
 */
export async function world(
  entries: readonly ResolvedEntry[],
  secrets: Record<string, string> = SECRETS,
) {
  const clock = systemClock();
  const store = StateStore.open({ path: ':memory:' });
  store.recover();
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const log = (event: string, fields: Record<string, unknown> = {}) => logs.push({ event, fields });
  let kernel: Kernel | undefined;
  const safety = new SafetyCore({
    store,
    clock,
    config: {
      simulation: true,
      leaseTtlMs: {},
      leaseCapabilities: {},
      presenceTtlMs: 600_000,
      rateLimits: {},
      guardTimeoutMs: 200,
      emergency: { stageSource: 'Stage', safeScene: 'Safe', stopStream: false },
      unattendedGatesSatisfied: false,
    },
    obs: { ready: true, run: async () => ({ ok: true, results: [] }) },
    permissionsOf: (holder) => kernel?.permissionsOf(holder),
    watchdogConnected: () => true,
    log,
  });
  const host = new Kernel({
    clock,
    safety: safety.kernelHooks(),
    log,
    activateTimeoutMs: 2000,
    retryDelaysMs: [],
  });
  kernel = host;
  const memory = new MemorySecretStore();
  for (const [name, value] of Object.entries(secrets)) await memory.set(name, value);
  host.provideCore(ClockService, clock);
  host.provideCore(RandomService, systemRandom());
  host.provideScoped(SafetyService, ({ instanceId }) => safetyFacade(safety, instanceId));
  host.provideScoped(SecretsService, ({ permissions }): PluginSecrets => {
    const check = (name: string) => {
      if (!permissions.has(secretPermission(name)))
        throw new Error(`没有权限 ${secretPermission(name)}`);
    };
    return {
      read: async (name) => {
        check(name);
        return memory.get(name);
      },
      write: async (name, value) => {
        check(name);
        await memory.set(name, value);
      },
      delete: async (name) => {
        check(name);
        return memory.delete(name);
      },
    };
  });
  safety.setModeration(false);
  host.add(entries, catalog(danmakuBilibili, triage, memoryTelemetry));
  await host.settled();
  const received: Danmaku[] = [];
  return {
    kernel: host,
    store,
    logs,
    received,
    state: (id: string) => host.snapshot().find((e) => e.id === id),
    service<T>(token: ServiceToken<T>): T {
      const found = host.services.resolve(token.name, token.major);
      if ('missing' in found) throw new Error(found.missing);
      return found.impl as T;
    },
    /** 订阅接入插件交出的弹幕。 */
    listen() {
      return this.service(DanmakuService).subscribe((danmaku) => received.push(danmaku));
    },
    candidates() {
      return this.service(CandidatesService);
    },
    events: (type: string) => store.events().filter((e) => e.type === type),
    logged: (event: string) => logs.filter((l) => l.event === event),
    async close() {
      await host.shutdown();
      store.close();
    },
  };
}
