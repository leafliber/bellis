import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { systemClock } from '@bellis/kernel';
import { IrisError, type IrisMessage } from '@bellis/memory';
import { IrisClient } from '../src/index.ts';
import { FakeIris } from './fake-iris.ts';

const TOKEN = 'FAKE-IRIS-TOKEN-client-7c41b9';
const ENTRY = 'bellis:bilibili:1001';

let fake: FakeIris;
before(async () => {
  fake = await FakeIris.start(TOKEN);
});
after(async () => {
  await fake.close();
});

function client(
  options: { baseUrl?: string; token?: string; timeoutMs?: number; maxBytes?: number } = {},
) {
  return new IrisClient({
    baseUrl: options.baseUrl ?? fake.url,
    token: options.token ?? TOKEN,
    clock: systemClock(),
    requestTimeoutMs: options.timeoutMs ?? 2000,
    maxResponseBytes: options.maxBytes ?? 1024 * 1024,
  });
}

const signal = () => new AbortController().signal;

const message = (key: string, overrides: Partial<IrisMessage> = {}): IrisMessage => ({
  platform: 'bilibili',
  sender: '观众0a1b2c3d',
  accountId: 'open-id-1',
  content: '今晚看星星',
  occurredAt: '2026-10-22T12:00:00.000Z',
  dedupeKey: key,
  kind: 'message',
  entryName: '直播间',
  entryKind: 'live',
  pace: 'standard',
  ...overrides,
});

async function rejection(work: Promise<unknown>): Promise<IrisError> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof IrisError, String(error));
    return error;
  }
  assert.fail('应当失败');
}

test('请求形状：Bearer 令牌只在请求头，Host 为 127.0.0.1:端口；写入总以数组提交、字段按契约的写法', async () => {
  const before = fake.requests.length;
  const { accountId: _account, ...self } = message('k-shape-2', { kind: 'self_output' });
  const result = await client().writeMessages(ENTRY, [message('k-shape-1'), self], signal());
  assert.equal(result.messageIds.length, 2);
  const request = fake.requests[before];
  assert.ok(request);
  assert.equal(request.method, 'POST');
  assert.equal(request.path, `/api/v1/entries/${encodeURIComponent(ENTRY)}/messages`);
  assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(request.headers.host, `127.0.0.1:${fake.port}`);
  assert.equal(request.headers['content-type'], 'application/json');
  assert.ok(!request.path.includes(TOKEN), '令牌不进 URL');
  assert.deepEqual(request.body, [
    {
      platform: 'bilibili',
      sender: '观众0a1b2c3d',
      account_id: 'open-id-1',
      content: '今晚看星星',
      occurred_at: '2026-10-22T12:00:00.000Z',
      dedupe_key: 'k-shape-1',
      kind: 'message',
      entry_name: '直播间',
      entry_kind: 'live',
      pace: 'standard',
    },
    {
      platform: 'bilibili',
      sender: '观众0a1b2c3d',
      content: '今晚看星星',
      occurred_at: '2026-10-22T12:00:00.000Z',
      dedupe_key: 'k-shape-2',
      kind: 'self_output',
      entry_name: '直播间',
      entry_kind: 'live',
      pace: 'standard',
    },
  ]);
});

test('召回准备只取记忆：关闭召回判断，不取人物要点、人物摘要、近期原始消息与目标；返回的记忆取用到的字段', async () => {
  await client().writeMessages(
    ENTRY,
    [message('k-prepare-1', { content: '主播喜欢猫' })],
    signal(),
  );
  const before = fake.requests.length;
  const recall = await client().prepare(
    ENTRY,
    { text: '猫', judge: false, memoryLimit: 5, tokenBudget: 600 },
    signal(),
  );
  assert.deepEqual(fake.requests[before]?.body, {
    text: '猫',
    judge: false,
    participants: [],
    people_limit: 0,
    recent_limit: 0,
    goal_limit: 0,
    memory_limit: 5,
    token_budget: 600,
  });
  assert.match(recall.recallId, /^recall-/);
  assert.equal(recall.judgment, 'disabled');
  const first = recall.memories[0];
  assert.ok(first);
  assert.equal(first.content, '主播喜欢猫');
  assert.equal(first.speakerName, '观众0a1b2c3d');
  assert.deepEqual(first.sources, [{ messageId: first.id, entryId: ENTRY }]);
  // 打开召回判断时才发预算；省略 text 时不发（由 Iris 自己构造查询）。
  await client().prepare(
    ENTRY,
    { judge: true, judgeBudgetSeconds: 1.5, memoryLimit: 1, tokenBudget: 100 },
    signal(),
  );
  const body = fake.requests.at(-1)?.body as Record<string, unknown>;
  assert.equal(body.judge_budget_seconds, 1.5);
  assert.ok(!('text' in body));
});

test('幂等：同一去重键重试返回原消息 ID，不覆盖正文，只存一次', async () => {
  const c = client();
  const first = await c.writeMessages(
    ENTRY,
    [message('k-idem-1', { content: '第一次' })],
    signal(),
  );
  const retry = await c.writeMessages(
    ENTRY,
    [message('k-idem-1', { content: '重试改了正文' })],
    signal(),
  );
  assert.deepEqual(retry.messageIds, first.messageIds);
  const stored = fake.messages.filter((m) => m.dedupeKey === 'k-idem-1');
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.body.content, '第一次');
});

test('使用反馈与定向查询：反馈只能用这次召回的记忆，重复反馈不再强化；定向查询带入口', async () => {
  const c = client();
  await c.writeMessages(ENTRY, [message('k-fb-1', { content: '观星需要三脚架' })], signal());
  const found = await c.search({ text: '三脚架', entryId: ENTRY, limit: 8 }, signal());
  assert.equal(found.memories.length, 1);
  const id = found.memories[0]?.id ?? -1;
  assert.deepEqual(fake.requests.at(-1)?.body, { text: '三脚架', entry_id: ENTRY, limit: 8 });
  assert.deepEqual(await c.feedback(found.recallId, [id], signal()), {
    accepted: [id],
    strengthened: [id],
  });
  assert.deepEqual(await c.feedback(found.recallId, [id], signal()), {
    accepted: [id],
    strengthened: [],
  });
  // 没有用到记忆：回报空集。
  assert.deepEqual(await c.feedback(found.recallId, [], signal()), {
    accepted: [],
    strengthened: [],
  });
  const invalid = await rejection(c.feedback(found.recallId, [999_999], signal()));
  assert.equal(invalid.kind, 'invalid');
  const missing = await rejection(c.feedback('no-such-recall', [], signal()));
  assert.equal(missing.kind, 'not_found');
});

test('错误分类：按 HTTP 状态与错误码，带字段路径与 Retry-After；说明里不含 Iris 的说明文字与令牌', async () => {
  const cases: Array<[ReturnType<typeof FakeIris.error>, string, Partial<IrisError>]> = [
    [
      FakeIris.error(401, 'unauthorized', { headers: { 'www-authenticate': 'Bearer' } }),
      'auth',
      { status: 401 },
    ],
    [FakeIris.error(403, 'entry_forbidden'), 'forbidden', { code: 'entry_forbidden' }],
    [FakeIris.error(404, 'not_found'), 'not_found', {}],
    [FakeIris.error(409, 'revision_conflict'), 'conflict', {}],
    [FakeIris.error(413, 'payload_too_large'), 'too_large', {}],
    [FakeIris.error(400, 'invalid_request', { fields: ['body.0.occurred_at'] }), 'invalid', {}],
    [FakeIris.error(429, 'rate_limited', { retryAfter: 3 }), 'rate_limit', { retryAfterMs: 3000 }],
    [
      {
        status: 503,
        body: '<html>维护中</html>',
        headers: { 'retry-after': '2', 'content-type': 'text/html' },
      },
      'unavailable',
      { retryAfterMs: 2000 },
    ],
    [FakeIris.error(500, 'internal'), 'server', {}],
    [{ status: 200, body: 'not json' }, 'protocol', {}],
    [{ status: 200, body: '{"message_ids":"x"}' }, 'protocol', {}],
  ];
  for (const [override, kind, extra] of cases) {
    fake.overrides.push({
      ...override,
      body: (override.body ?? '').replace('错误', `服务端说明里复述了令牌 ${TOKEN}`),
    });
    const error = await rejection(client().writeMessages(ENTRY, [message('k-err')], signal()));
    assert.equal(error.kind, kind, `${override.status} → ${kind}`);
    for (const [key, value] of Object.entries(extra)) {
      assert.equal((error as unknown as Record<string, unknown>)[key], value, `${kind} ${key}`);
    }
    assert.ok(!error.message.includes(TOKEN), `${kind} 的说明不含令牌`);
    assert.ok(!error.message.includes('服务端说明'), `${kind} 的说明不含 Iris 的说明文字`);
  }
  // 400 的说明带出错的字段路径。
  fake.overrides.push(FakeIris.error(400, 'invalid_request', { fields: ['body.0.occurred_at'] }));
  const invalid = await rejection(client().writeMessages(ENTRY, [message('k-err')], signal()));
  assert.match(invalid.message, /body\.0\.occurred_at/);
  assert.equal(invalid.code, 'invalid_request');
});

test('真实的契约检查：错误的令牌得 401，非回环的 Host 得 400（由伪 Iris 按契约核验）', async () => {
  const denied = await rejection(client({ token: 'wrong-token' }).status(signal()));
  assert.equal(denied.kind, 'auth');
  assert.ok(!denied.message.includes('wrong-token'));
  // localhost 也是契约接受的 Host。
  const viaLocalhost = await client({ baseUrl: `http://localhost:${fake.port}` }).status(signal());
  assert.equal(viaLocalhost.service, 'ready');
});

test('超时、连接失败、取消、返回体超过上限都按类别结束；不做隐式重试', async () => {
  const before = fake.requests.length;
  fake.overrides.push({ status: 200, body: '{}', delayMs: 500 });
  const timeout = await rejection(client({ timeoutMs: 100 }).status(signal()));
  assert.equal(timeout.kind, 'timeout');
  assert.equal(fake.requests.length, before + 1, '超时不重试');

  // 没有服务在监听的端口。
  const idle = createServer();
  await new Promise<void>((resolve) => idle.listen(0, '127.0.0.1', resolve));
  const { port } = idle.address() as AddressInfo;
  await new Promise<void>((resolve) => idle.close(() => resolve()));
  const refused = await rejection(client({ baseUrl: `http://127.0.0.1:${port}` }).status(signal()));
  assert.equal(refused.kind, 'network');
  assert.ok(!refused.message.includes(TOKEN));

  const controller = new AbortController();
  fake.overrides.push({ status: 200, body: '{}', delayMs: 500 });
  const pending = client().status(controller.signal);
  setTimeout(() => controller.abort(), 20);
  assert.equal((await rejection(pending)).kind, 'aborted');
  controller.abort();
  assert.equal((await rejection(client().status(controller.signal))).kind, 'aborted');

  fake.overrides.push({
    status: 200,
    body: JSON.stringify({ service: 'ready', pad: 'x'.repeat(4096) }),
  });
  assert.equal((await rejection(client({ maxBytes: 1024 }).status(signal()))).kind, 'protocol');
});

test('不跟随重定向；入口 ID 不合法时不发请求', async () => {
  const before = fake.requests.length;
  fake.overrides.push({
    status: 302,
    body: '',
    headers: { location: 'http://127.0.0.1:1/elsewhere' },
  });
  const redirected = await rejection(client().status(signal()));
  assert.equal(redirected.kind, 'network');
  assert.equal(fake.requests.length, before + 1);
  for (const entry of ['', ' ', 'a?b', 'a#b', 'a\nb', 'a/b', 'x'.repeat(201)]) {
    const error = await rejection(client().writeMessages(entry, [message('k-entry')], signal()));
    assert.equal(error.kind, 'invalid', JSON.stringify(entry));
  }
  assert.equal(fake.requests.length, before + 1);
  const empty = await rejection(client().writeMessages(ENTRY, [], signal()));
  assert.equal(empty.kind, 'invalid');
});
