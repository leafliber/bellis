import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { type Scenario, scenarioArbitrary, simulate } from '../src/index.ts';

/** 固定种子集：每次提交都在这些种子上跑完全部不变量。 */
const SEEDS = [1, 2, 3, 42, 2026];

for (const seed of SEEDS) {
  test(`确定性仿真：种子 ${seed} 上全部不变量成立`, async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary(), async (scenario) => {
        const result = await simulate(scenario);
        assert.deepEqual(result.violations, []);
      }),
      { seed, numRuns: 20 },
    );
  });
}

test('同一场景与种子两次运行得到完全相同的追踪与事件', async () => {
  await fc.assert(
    fc.asyncProperty(scenarioArbitrary(10_000), async (scenario) => {
      const first = await simulate(scenario, { drainMs: 5_000 });
      const second = await simulate(scenario, { drainMs: 5_000 });
      assert.deepEqual(second.history, first.history);
    }),
    { seed: 7, numRuns: 5 },
  );
});

/** 曾经由仿真找到、收缩后的场景，作为回归用例保留。 */
const regressions: Array<[string, Scenario]> = [
  [
    '审核启用时，含禁词的定时播报不会播出',
    {
      seed: 0,
      moderation: { enabled: true, onError: 'skip', delayMs: 0 },
      ttsSlow: false,
      danmaku: [],
      outputs: [],
      announcements: [{ atMs: 0, sentences: [2], immediate: false }],
      operator: [],
      durationMs: 20_000,
    },
  ],
  [
    '闲聊在句中被急停打断，只写回已播出的部分',
    {
      seed: 0,
      moderation: { enabled: false, onError: 'skip', delayMs: 0 },
      ttsSlow: false,
      danmaku: [
        { atMs: 0, viewer: 0, nickname: 0, text: 0 },
        { atMs: 0, viewer: 0, nickname: 0, text: 0 },
      ],
      outputs: [{ kind: 'invalid' }, { kind: 'invalid' }, { kind: 'chatter', sentences: [0] }],
      announcements: [],
      operator: [{ atMs: 4600, action: 'estop' }],
      durationMs: 20_000,
    },
  ],
  [
    '播放中崩溃重启：结果未知的句子不重做，结案后继续',
    {
      seed: 3,
      moderation: { enabled: true, onError: 'pass', delayMs: 0 },
      ttsSlow: true,
      danmaku: [{ atMs: 0, viewer: 1, nickname: 1, text: 1 }],
      outputs: [
        { kind: 'reply', sentences: [0, 1, 4], target: 1 },
        { kind: 'chatter', sentences: [5] },
      ],
      announcements: [{ atMs: 9000, sentences: [6], immediate: false }],
      operator: [{ atMs: 2000, action: 'restart' }],
      durationMs: 20_000,
    },
  ],
];

for (const [name, scenario] of regressions) {
  test(`回归：${name}`, async () => {
    const result = await simulate(scenario);
    assert.deepEqual(result.violations, []);
  });
}

test('崩溃重启后，此前执行中的意图被结案而没有重做', async () => {
  const [, scenario] = regressions[2] as [string, Scenario];
  const result = await simulate(scenario);
  assert.equal(result.restarts, 1);
  const orphaned = result.history.events.filter((e) => e.type === 'intent.orphaned');
  assert.ok(orphaned.length > 0, '重启时应有执行中的意图被标为 unknown');
  const reconciled = result.history.events.filter((e) => e.type === 'intent.reconciled');
  assert.equal(reconciled.length, orphaned.length);
});
