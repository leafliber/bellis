import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  ClockService,
  catalog,
  Kernel,
  type PluginSecrets,
  type ResolvedEntry,
  SecretsService,
  secretPermission,
  systemClock,
} from '@bellis/kernel';
import { type Iris, IrisError, IrisService } from '@bellis/memory';
import { SafetyCore } from '@bellis/safety';
import { MemorySecretStore } from '@bellis/secret-store';
import { StateStore } from '@bellis/store';
import { baseUrlBlocker, irisClient } from '../src/index.ts';
import { FakeIris } from './fake-iris.ts';

const TOKEN = 'FAKE-IRIS-TOKEN-plugin-4b2e17';
const GRANT = ['net.egress:127.0.0.1', 'secret:iris'];
const ENTRY = 'bellis:test';

let fake: FakeIris;
before(async () => {
  fake = await FakeIris.start(TOKEN);
});
after(async () => {
  await fake.close();
});

/** 真实时钟下的小世界：插件内核与安全核（仿真模式），凭据服务按授予的权限放行，凭据存在内存里。 */
async function world(
  config: Record<string, unknown>,
  options: { secrets?: Record<string, string>; grant?: string[] } = {},
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
  for (const [name, value] of Object.entries(options.secrets ?? { iris: TOKEN })) {
    await memory.set(name, value);
  }
  host.provideCore(ClockService, clock);
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
  const entry: ResolvedEntry = {
    id: 'iris',
    plugin: 'iris-client',
    config,
    disabled: false,
    explicitSwitch: false,
    grant: options.grant ?? GRANT,
  };
  host.add([entry], catalog(irisClient));
  await host.settled();
  return {
    logs,
    state: () => host.snapshot().find((e) => e.id === 'iris'),
    iris(): Iris {
      const found = host.services.resolve(IrisService.name, IrisService.major);
      if ('missing' in found) throw new Error(found.missing);
      return found.impl as Iris;
    },
    async close() {
      await host.shutdown();
      store.close();
    },
  };
}

const reviewed = () => ({ baseUrl: fake.url, egressReviewed: true });

test('维护者没有确认 Iris 的外发配置已核对时不激活，不发任何请求', async () => {
  const before = fake.requests.length;
  for (const config of [{ baseUrl: fake.url }, { baseUrl: fake.url, egressReviewed: false }]) {
    const w = await world(config);
    try {
      assert.equal(w.state()?.state, 'failed');
      assert.match(w.state()?.reason ?? '', /egressReviewed/);
    } finally {
      await w.close();
    }
  }
  assert.equal(fake.requests.length, before);
});

test('外发按主机授权：即使是本机回环也要授予；回环之外只认 https；缺凭据说明怎样录入', async () => {
  // 清单按缺省地址申请 net.egress:127.0.0.1：没有授予就停在 WAITING，说明缺哪项权限。
  const noGrant = await world(reviewed(), { grant: ['secret:iris'] });
  try {
    assert.equal(noGrant.state()?.state, 'waiting');
    assert.match(noGrant.state()?.reason ?? '', /net\.egress:127\.0\.0\.1/);
  } finally {
    await noGrant.close();
  }
  const noSecret = await world(reviewed(), { secrets: {} });
  try {
    assert.equal(noSecret.state()?.state, 'failed');
    assert.match(noSecret.state()?.reason ?? '', /pnpm secret set iris/);
  } finally {
    await noSecret.close();
  }
  const granted = new Set([
    'net.egress:127.0.0.1',
    'net.egress:iris.example',
    'net.egress:localhost',
  ]);
  assert.equal(baseUrlBlocker('http://127.0.0.1:8080', granted), undefined);
  assert.equal(baseUrlBlocker('http://localhost:8080/', granted), undefined);
  assert.match(baseUrlBlocker('http://iris.example:8080', granted) ?? '', /https/);
  assert.equal(baseUrlBlocker('https://iris.example', granted), undefined);
  assert.match(baseUrlBlocker('http://u:p@127.0.0.1:8080', granted) ?? '', /用户名/);
  assert.match(baseUrlBlocker('http://127.0.0.1:8080/api/v1', granted) ?? '', /路径/);
  assert.match(baseUrlBlocker('http://127.0.0.1:8080/?token=x', granted) ?? '', /查询/);
  assert.match(baseUrlBlocker('http://[::1]:8080', granted) ?? '', /net\.egress:\[::1\]/);
});

test('提供 iris@1：写入、召回与预检的访问都带令牌；失败只记类别、HTTP 状态与错误码，令牌不进日志', async () => {
  const w = await world({ ...reviewed(), unreadyAfter: 2 });
  try {
    assert.equal(w.state()?.state, 'active');
    const iris = w.iris();
    const signal = new AbortController().signal;
    assert.equal(iris.ready, true);
    assert.match(iris.status, /还没有请求过/);
    assert.deepEqual(await iris.check(signal), { service: 'ready' });
    const written = await iris.write(
      ENTRY,
      [
        {
          platform: 'bilibili',
          sender: '主播',
          content: '大家好',
          occurredAt: '2026-10-22T12:00:00.000Z',
          dedupeKey: 'k-plugin-1',
          kind: 'self_output',
        },
      ],
      signal,
    );
    assert.equal(written.messageIds.length, 1);
    const recall = await iris.prepare(
      ENTRY,
      { judge: false, memoryLimit: 3, tokenBudget: 300 },
      signal,
    );
    assert.equal(recall.memories[0]?.content, '大家好');

    fake.overrides.push(FakeIris.error(503, 'not_ready', { retryAfter: 1 }));
    fake.overrides.push(FakeIris.error(500, 'internal'));
    for (let i = 0; i < 2; i += 1) {
      await assert.rejects(iris.check(signal), (error) => error instanceof IrisError);
    }
    assert.equal(iris.ready, false, '连续失败达到 unreadyAfter 即未就绪');
    assert.match(iris.status, /连续失败 2 次（最近一次：server，HTTP 500，internal）/);
    assert.equal(iris.failures.consecutive, 2);
    await iris.check(signal);
    assert.equal(iris.ready, true, '下一次成功即恢复');

    fake.overrides.push(FakeIris.error(401, 'unauthorized'));
    await assert.rejects(iris.check(signal));
    assert.equal(iris.ready, false, '鉴权失败一次就未就绪');
    assert.match(iris.status, /鉴权失败/);

    const failed = w.logs.filter((l) => l.event === 'iris.failed').map((l) => l.fields);
    assert.ok(failed.length >= 3);
    for (const fields of failed) {
      assert.deepEqual(
        Object.keys(fields)
          .filter((k) => !['entry', 'instance'].includes(k))
          .sort(),
        ['code', 'kind', 'operation', 'status'],
      );
    }
    assert.ok(!JSON.stringify(w.logs).includes(TOKEN), '令牌不进日志');
  } finally {
    await w.close();
  }
});
