import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { INTENT_OUTPUT, type Llm, LlmError, LlmService } from '@bellis/director';
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
import { SafetyCore } from '@bellis/safety';
import { MemorySecretStore } from '@bellis/secret-store';
import { StateStore } from '@bellis/store';
import { ARK_PROVIDER, llmOpenAi } from '../src/index.ts';
import { FakeChat, respond, status } from './fake-chat.ts';
import { ARK_MODEL, arkReasoningStream, INTENT } from './fixtures.ts';

const KEY = 'FAKE-ARK-KEY-plugin-5d8e2a';
const GRANT = ['net.egress:ark.cn-beijing.volces.com', 'net.egress:127.0.0.1', 'secret:ark'];

let fake: FakeChat;
before(async () => {
  fake = await FakeChat.start();
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
  for (const [name, value] of Object.entries(options.secrets ?? { ark: KEY })) {
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
    id: 'llm',
    plugin: 'llm-openai',
    config,
    disabled: false,
    explicitSwitch: false,
    grant: options.grant ?? GRANT,
  };
  host.add([entry], catalog(llmOpenAi));
  await host.settled();
  return {
    kernel: host,
    logs,
    state: () => host.snapshot().find((e) => e.id === 'llm'),
    llm(): Llm {
      const found = host.services.resolve(LlmService.name, LlmService.major);
      if ('missing' in found) throw new Error(found.missing);
      return found.impl as Llm;
    },
    async close() {
      await host.shutdown();
      store.close();
    },
  };
}

const request = {
  messages: [{ role: 'user' as const, content: '你好' }],
  output: INTENT_OUTPUT,
  context: { persona: '', triggers: [], heard: [], candidates: [], vote: null, endedVote: null },
  traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
};

const base = { endpoint: '', model: ARK_MODEL, outputMode: 'json_schema', reasoningEffort: 'low' };

test('提供 llm@1：型号与厂商来自配置；返回正文；traceparent 与上下文不发给模型服务', async () => {
  fake.script = respond(arkReasoningStream());
  const w = await world({ ...base, endpoint: fake.url });
  try {
    assert.equal(w.state()?.state, 'active');
    const llm = w.llm();
    assert.deepEqual(llm.model, { provider: ARK_PROVIDER, name: ARK_MODEL });
    const firsts: string[] = [];
    const output = await llm.complete(request, new AbortController().signal, {
      onFirstChunk: () => firsts.push('chunk'),
      onFirstOutput: () => firsts.push('output'),
    });
    assert.equal(output, INTENT);
    assert.deepEqual(firsts, ['chunk', 'output']);
    const sent = fake.requests.at(-1);
    assert.equal(sent?.headers.traceparent, undefined);
    assert.equal(sent?.body.reasoning_effort, 'low');
    assert.ok(!('thinking' in (sent?.body ?? {})), '没有配置的思考开关不发');
    const raw = JSON.stringify(sent?.body);
    assert.ok(!raw.includes(request.traceparent));
    assert.ok(!raw.includes('triggers'), '结构化上下文不发');
  } finally {
    await w.close();
  }
  assert.ok(!JSON.stringify(w.logs).includes(KEY));
});

test('凭据或配置缺失：加载失败并说明原因，不连任何端点', async () => {
  const requests = fake.requests.length;
  const cases: Array<
    [Record<string, unknown>, { secrets?: Record<string, string>; grant?: string[] }, RegExp]
  > = [
    [
      { ...base, endpoint: fake.url },
      { secrets: {} },
      /缺少凭据 ark（维护者用 pnpm secret set ark 录入方舟的 API Key）/,
    ],
    [{ ...base, endpoint: fake.url }, { secrets: { ark: '   ' } }, /缺少凭据 ark/],
    [{ ...base, endpoint: fake.url, model: '' }, {}, /未配置型号（model）/],
    [
      { ...base, endpoint: 'http://ark.cn-beijing.volces.com/api/v3/chat/completions' },
      {},
      /端点须为 https:\/\/（本机测试除外）/,
    ],
    [
      { ...base, endpoint: 'https://api.example.com/v1/chat/completions' },
      {},
      /未授予权限 net\.egress:api\.example\.com/,
    ],
    [{ ...base, endpoint: 'not a url' }, {}, /端点地址不合法/],
    [
      { ...base, endpoint: fake.url },
      { grant: ['net.egress:ark.cn-beijing.volces.com', 'secret:ark'] },
      /未授予权限 net\.egress:127\.0\.0\.1/,
    ],
  ];
  for (const [config, options, reason] of cases) {
    const w = await world(config, options);
    try {
      assert.equal(w.state()?.state, 'failed', JSON.stringify(config));
      assert.match(String(w.state()?.reason), reason);
    } finally {
      await w.close();
    }
  }
  // 没有输出方式：配置不合 Schema，同样加载失败。
  const { outputMode: _omit, ...noMode } = base;
  const w = await world({ ...noMode, endpoint: fake.url });
  try {
    assert.equal(w.state()?.state, 'failed');
    assert.match(String(w.state()?.reason), /outputMode/);
  } finally {
    await w.close();
  }
  assert.equal(fake.requests.length, requests, '不连任何端点');
});

test('清单只申请方舟的外发与 secret:ark；没有授予就停在等待', async () => {
  assert.deepEqual(llmOpenAi.manifest.permissions, [
    'net.egress:ark.cn-beijing.volces.com',
    'secret:ark',
  ]);
  const w = await world({ ...base, endpoint: fake.url }, { grant: ['net.egress:127.0.0.1'] });
  try {
    assert.equal(w.state()?.state, 'waiting');
    assert.match(String(w.state()?.reason), /未授予权限 secret:ark/);
  } finally {
    await w.close();
  }
});

test('失败只记类别、HTTP 状态与错误码；取消不记失败；停用即中止在途调用', async () => {
  const w = await world({ ...base, endpoint: fake.url });
  try {
    fake.script = status(
      429,
      JSON.stringify({ error: { code: 'RateLimitExceeded', message: `key ${KEY} too fast` } }),
    );
    await assert.rejects(
      w.llm().complete(request, new AbortController().signal),
      (error: unknown) => error instanceof LlmError && error.kind === 'rate_limit',
    );
    assert.deepEqual(
      w.logs.filter((l) => l.event === 'llm.failed').map((l) => l.fields),
      [
        {
          entry: 'llm',
          instance: w.state()?.instanceId,
          kind: 'rate_limit',
          status: 429,
          code: 'RateLimitExceeded',
        },
      ],
    );

    fake.script = respond(arkReasoningStream(), 200);
    const cancel = new AbortController();
    const cancelled = w.llm().complete(request, cancel.signal);
    setTimeout(() => cancel.abort(), 50);
    await assert.rejects(
      cancelled,
      (error: unknown) => error instanceof LlmError && error.kind === 'aborted',
    );
    assert.equal(w.logs.filter((l) => l.event === 'llm.failed').length, 1, '取消不记失败');

    const before = fake.disconnects;
    const inflight = w.llm().complete(request, new AbortController().signal);
    const rejected = assert.rejects(
      inflight,
      (error: unknown) => error instanceof LlmError && error.kind === 'aborted',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await w.kernel.disable('llm');
    await rejected;
    await fake.waitDisconnect(before + 1);
  } finally {
    await w.close();
  }
  assert.ok(!JSON.stringify(w.logs).includes(KEY), '日志不含 API Key');
});
