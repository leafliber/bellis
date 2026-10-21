import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReplayLlmService } from '@bellis/director';
import { SimIrisBackend } from '@bellis/memory';
import fc from 'fast-check';
import { type Scenario, scenarioArbitrary, simulate } from '../src/index.ts';
import { speak, startChain } from './helpers.ts';

test('全模拟链路：弹幕与角色说出口的部分写入模拟 Iris，下一次决策召回它们，只放进不可信数据区', async () => {
  const backend = new SimIrisBackend();
  const world = await startChain({
    moderation: { enabled: false },
    messages: [
      { atMs: 0, id: 'd1', viewer: 'v1', nickname: '小明', text: '主播你好' },
      { atMs: 8_000, id: 'd2', viewer: 'v2', nickname: '小红', text: '今天玩什么' },
    ],
    outputs: [speak('谢谢你来！', 'c-d1'), speak('玩魔女审判。', 'c-d2')],
    memory: { backend, config: { write: { flushDelayMs: 500 } } },
  });
  try {
    const llm = world.service(ReplayLlmService);
    await world.until(() => llm.requests.length === 2, 30_000);
    assert.deepEqual(llm.requests[0]?.context.memories, [], '第一次决策时 Iris 里还没有内容');
    assert.deepEqual(
      backend.messages.map((m) => [m.kind, m.content]),
      [
        ['message', '主播你好'],
        ['self_output', '谢谢你来！'],
      ],
    );
    const memories = llm.requests[1]?.context.memories ?? [];
    assert.deepEqual(
      memories.map((m) => m.text),
      ['谢谢你来！', '主播你好'],
    );
    const user = llm.requests[1]?.messages[1]?.content ?? '';
    const zone = user.slice(user.indexOf('<不可信数据>'), user.indexOf('</不可信数据>'));
    assert.ok(zone.includes('谢谢你来！'));
    assert.ok(!user.replace(zone, '').includes('谢谢你来！'), '记忆只在不可信数据区');
  } finally {
    await world.close();
  }
});

test('召回超时不阻塞：模拟 Iris 召回要 3 秒，决策插件 1 秒截止，到点不带记忆继续决策', async () => {
  const world = await startChain({
    moderation: { enabled: false },
    messages: [{ atMs: 0, id: 'd1', viewer: 'v1', nickname: '小明', text: '主播你好' }],
    outputs: [speak('你好！', 'c-d1')],
    director: { recallTimeoutMs: 1_000 },
    memory: { iris: { recallDelayMs: 3_000 } },
  });
  try {
    const llm = world.service(ReplayLlmService);
    const started = world.clock.now();
    await world.until(() => llm.requests.length === 1, 10_000);
    const waited = world.clock.now() - started;
    assert.ok(waited >= 1_000 && waited < 1_200, `等了 ${waited}ms`);
    assert.deepEqual(llm.requests[0]?.context.memories, []);
    assert.ok(world.logs.some((l) => l.event === 'director.recall-skipped'));
  } finally {
    await world.close();
  }
});

/** 由仿真找到或手写的场景：写入失败、应答丢失、重启与墓碑交织。 */
const regression: Scenario = {
  seed: 11,
  moderation: { enabled: false, onError: 'skip', delayMs: 0 },
  ttsSlow: false,
  danmaku: [
    { atMs: 0, viewer: 1, nickname: 0, text: 0 },
    { atMs: 1_000, viewer: 2, nickname: 1, text: 1 },
    { atMs: 3_000, viewer: 1, nickname: 0, text: 13 },
    { atMs: 9_000, viewer: 1, nickname: 0, text: 1 },
    { atMs: 9_500, viewer: 2, nickname: 1, text: 0 },
  ],
  outputs: [
    { kind: 'reply', sentences: [0], target: 1 },
    { kind: 'chatter', sentences: [5] },
    { kind: 'reply', sentences: [1], target: 4 },
  ],
  announcements: [],
  operator: [{ atMs: 6_000, action: 'restart' }],
  memory: {
    recallDelayMs: 50,
    writeDelayMs: 300,
    writeFaults: ['lost', 'reject', 'ok'],
    forget: [{ atMs: 8_000, viewer: 1 }],
  },
  durationMs: 20_000,
};

test('回归：应答丢失、503、崩溃重启与墓碑交织，记忆的不变量成立', async () => {
  const result = await simulate(regression);
  assert.deepEqual(result.violations, []);
  const { trace, events } = result.history;
  const stored = trace
    .filter((e) => e.kind === 'iris.write')
    .flatMap((e) =>
      Array.isArray(e.data.stored) ? (e.data.stored as Array<{ account: string | null }>) : [],
    );
  assert.ok(stored.length > 0, 'Iris 存下了内容');
  assert.ok(
    trace.some((e) => e.kind === 'memory.recalled'),
    '有召回',
  );
  assert.equal(events.filter((e) => e.type === 'memory.tombstoned').length, 1);
  // 含所在地的弹幕被隐私网关拦下。
  assert.ok(
    events.some((e) => e.type === 'memory.filtered' && JSON.stringify(e.data).includes('location')),
  );
  // 墓碑之后 v1 的弹幕没有排队（d4 在 9 秒）。
  const after = events.find((e) => e.type === 'memory.tombstoned')?.seq ?? 0;
  assert.ok(
    !events.some(
      (e) =>
        e.type === 'memory.queued' &&
        e.seq > after &&
        (e.data as { account?: string }).account === 'v1',
    ),
  );
});

test('回归：重启那一刻到达的弹幕在新旧两次启动里都送出（平台重发），Iris 只存一次', async () => {
  const scenario: Scenario = {
    seed: 0,
    moderation: { enabled: false, onError: 'skip', delayMs: 0 },
    ttsSlow: false,
    danmaku: [{ atMs: 19_990, viewer: 0, nickname: 0, text: 0 }],
    gaps: [],
    outputs: [],
    announcements: [],
    operator: [{ atMs: 19_990, action: 'restart' }],
    presentationMs: 0,
    ttsRpm: 0,
    memory: { recallDelayMs: 0, writeDelayMs: 0, writeFaults: [], forget: [] },
    durationMs: 20_000,
  };
  const result = await simulate(scenario);
  assert.deepEqual(result.violations, []);
  const delivered = result.history.trace.filter(
    (e) => e.kind === 'danmaku.delivered' && e.data.id === 'd1',
  );
  assert.equal(delivered.length, 2, '新旧两次启动各送出一次');
  const stored = result.history.trace
    .filter((e) => e.kind === 'iris.write')
    .flatMap((e) => (Array.isArray(e.data.stored) ? e.data.stored : []));
  assert.equal(stored.length, 1);
});

test('生成的场景里记忆确实在工作：写入、召回、墓碑与故障都出现过（不变量不是空转）', async () => {
  const scenarios = fc.sample(scenarioArbitrary(), { seed: 5, numRuns: 12 });
  let stored = 0;
  let recalled = 0;
  let tombstones = 0;
  let faults = 0;
  for (const scenario of scenarios) {
    const result = await simulate(scenario, { drainMs: 5_000 });
    assert.deepEqual(result.violations, []);
    stored += result.history.trace.filter((e) => e.kind === 'iris.write').length;
    recalled += result.history.trace.filter((e) => e.kind === 'memory.recalled').length;
    tombstones += result.history.events.filter((e) => e.type === 'memory.tombstoned').length;
    faults += result.history.trace.filter(
      (e) => e.kind === 'iris.write' && e.data.fault !== 'ok',
    ).length;
  }
  assert.ok(
    stored > 0 && recalled > 0 && tombstones > 0 && faults > 0,
    JSON.stringify({ stored, recalled, tombstones, faults }),
  );
});
