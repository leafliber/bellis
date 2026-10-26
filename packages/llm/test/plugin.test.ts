import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { INTENT_OUTPUT, type Llm, LlmError, LlmService } from '@bellis/director';
import {
  ClockService,
  catalog,
  DeadlineError,
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
import { ARK_PROVIDER, llmOpenAi, PROBE_REQUEST } from '../src/index.ts';
import { FakeChat, respond, status } from './fake-chat.ts';
import { ARK_MODEL, arkReasoningStream, INTENT, pieces, REASONING_MARK } from './fixtures.ts';

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
  context: {
    persona: '',
    triggers: [],
    heard: [],
    candidates: [],
    vote: null,
    endedVote: null,
    memories: [],
  },
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
    const deltas: string[] = [];
    const output = await llm.complete(request, new AbortController().signal, {
      onFirstChunk: () => firsts.push('chunk'),
      onFirstOutput: () => firsts.push('output'),
      onOutput: (delta) => deltas.push(delta),
    });
    assert.equal(output, INTENT);
    assert.deepEqual(firsts, ['chunk', 'output']);
    // 正文的增量透传给调用方（决策插件的增量解析），按到达的顺序拼起来就是返回值，不含思考内容。
    assert.deepEqual(deltas, pieces(INTENT, 7));
    assert.ok(!deltas.join('').includes(REASONING_MARK));
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
  // 没有写输出方式：用缺省的 json_object（S-11 之后定），照常激活，激活本身不连端点。
  const { outputMode: _omit, ...noMode } = base;
  const w = await world({ ...noMode, endpoint: fake.url });
  try {
    assert.equal(w.state()?.state, 'active');
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

const failsWith = (kind: string) => (error: unknown) =>
  error instanceof LlmError && error.kind === kind;

test('就绪不发请求：鉴权失败后未就绪、成功后恢复；连续失败到阈值未就绪；取消不算，截止时间到点算超时', async () => {
  const w = await world({ ...base, endpoint: fake.url, unreadyAfter: 2 });
  try {
    const requests = fake.requests.length;
    const llm = w.llm();
    assert.equal(llm.ready, true);
    assert.equal(llm.status, '就绪（还没有调用过）');
    assert.deepEqual(llm.failures, { consecutive: 0 });
    assert.equal(fake.requests.length, requests, '读就绪状态不发请求');

    const said = `invalid key ${KEY}`;
    fake.script = status(
      401,
      JSON.stringify({ error: { code: 'AuthenticationError', message: said } }),
    );
    await assert.rejects(llm.complete(request, new AbortController().signal), failsWith('auth'));
    assert.equal(llm.ready, false);
    assert.equal(
      llm.status,
      '鉴权失败（auth，HTTP 401，AuthenticationError），下一次成功之前不就绪',
    );
    assert.equal(llm.failures?.consecutive, 1);
    assert.equal(llm.failures?.last?.kind, 'auth');
    assert.equal(typeof llm.failures?.last?.at, 'number');
    assert.ok(!JSON.stringify(llm.failures).includes('invalid key'), '不含服务端的说明');

    fake.script = respond(arkReasoningStream());
    assert.equal(await llm.complete(request, new AbortController().signal), INTENT);
    assert.equal(llm.ready, true, '成功后恢复');
    assert.equal(llm.status, '就绪');
    assert.equal(llm.failures?.consecutive, 0);

    fake.script = status(503, JSON.stringify({ error: { code: 'ServiceUnavailable' } }));
    await assert.rejects(llm.complete(request, new AbortController().signal), failsWith('server'));
    assert.equal(llm.ready, true, '连续失败少于阈值仍就绪');
    // 调用方取消：不算失败。
    fake.script = respond(arkReasoningStream(), 200);
    const cancel = new AbortController();
    const cancelled = llm.complete(request, cancel.signal);
    setTimeout(() => cancel.abort(), 50);
    await assert.rejects(cancelled, failsWith('aborted'));
    assert.equal(llm.failures?.consecutive, 1);
    assert.equal(llm.ready, true);
    // 调用方的截止时间到点（中止原因是 DeadlineError）：算超时，达到阈值后未就绪。
    const deadline = new AbortController();
    const late = llm.complete(request, deadline.signal);
    setTimeout(() => deadline.abort(new DeadlineError('决策模型调用 未在 50ms 内完成')), 50);
    await assert.rejects(late, failsWith('aborted'));
    assert.equal(llm.failures?.consecutive, 2);
    assert.equal(llm.failures?.last?.kind, 'timeout');
    assert.equal(llm.ready, false);
    assert.equal(llm.status, '连续失败 2 次（最近一次：timeout）');
    assert.ok(
      w.logs.some((l) => l.event === 'llm.failed' && l.fields.kind === 'timeout'),
      '截止时间到点记一条超时',
    );
  } finally {
    await w.close();
  }
  assert.ok(!JSON.stringify(w.logs).includes(KEY), '日志不含 API Key');
});

test('probeOnPreflight 关闭（缺省）时不提供探测，也不发请求', async () => {
  const w = await world({ ...base, endpoint: fake.url });
  try {
    const requests = fake.requests.length;
    assert.equal(w.llm().probe, undefined);
    assert.equal(w.llm().ready, true);
    assert.equal(fake.requests.length, requests);
  } finally {
    await w.close();
  }
});

test('probeOnPreflight 打开时向本机伪端点发固定的极短探测：合法响应算成功，失败与超时计入就绪', async () => {
  const w = await world({
    ...base,
    endpoint: fake.url,
    probeOnPreflight: true,
    probeTimeoutMs: 300,
  });
  try {
    const llm = w.llm();
    const probe = llm.probe;
    assert.ok(probe, '打开时提供探测');
    fake.script = respond(arkReasoningStream('{"ok":true}'));
    const requests = fake.requests.length;
    await probe();
    assert.equal(fake.requests.length, requests + 1, '发了一个请求');
    const sent = fake.requests.at(-1)?.body;
    assert.deepEqual(sent?.messages, PROBE_REQUEST.messages, '固定的极短提示词，不含任何上下文');
    assert.equal(sent?.model, ARK_MODEL);
    assert.equal(sent?.reasoning_effort, 'low');
    assert.equal(llm.ready, true);
    assert.deepEqual(
      w.logs.filter((l) => l.event === 'llm.probe').map((l) => l.fields.ok),
      [true],
    );

    // 鉴权失败：未就绪。
    fake.script = status(401, JSON.stringify({ error: { code: 'AuthenticationError' } }));
    await assert.rejects(probe(), failsWith('auth'));
    assert.equal(llm.ready, false);
    // 应答不是 JSON 对象：不算合法响应。
    fake.script = respond(arkReasoningStream('好的，我在。'));
    await assert.rejects(probe(), failsWith('protocol'));
    // 迟迟没有应答：探测的截止时间到点算超时，并断开连接。
    const before = fake.disconnects;
    fake.script = (exchange) => {
      exchange.res.writeHead(200, { 'content-type': 'text/event-stream' });
    };
    await assert.rejects(probe(), failsWith('timeout'));
    await fake.waitDisconnect(before + 1);
    assert.equal(llm.failures?.consecutive, 3);
    assert.equal(llm.failures?.last?.kind, 'timeout');

    // 探测成功：清掉之前的失败。
    fake.script = respond(arkReasoningStream('{"ok":true}'));
    await probe();
    assert.equal(llm.ready, true);
    assert.equal(llm.failures?.consecutive, 0);
  } finally {
    await w.close();
  }
  assert.ok(!JSON.stringify(w.logs).includes(KEY), '日志不含 API Key');
});
