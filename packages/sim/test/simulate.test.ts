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
  [
    '急停后在同一时刻重启：被拒的定时播报在新进程里重新播出，写回按各自的进程核对',
    {
      seed: 0,
      moderation: { enabled: false, onError: 'skip', delayMs: 0 },
      ttsSlow: false,
      danmaku: [],
      outputs: [],
      announcements: [{ atMs: 19210, sentences: [0], immediate: false }],
      operator: [
        { atMs: 19210, action: 'restart' },
        { atMs: 0, action: 'estop' },
      ],
      durationMs: 20_000,
    },
  ],
  [
    '急停吊销许可的截断回报排在停止信号之前：写回仍扣掉呈现延迟',
    {
      seed: 0,
      moderation: { enabled: false, onError: 'skip', delayMs: 0 },
      ttsSlow: false,
      danmaku: [{ atMs: 0, viewer: 0, nickname: 0, text: 0 }],
      outputs: [
        { kind: 'invalid' },
        { kind: 'invalid' },
        { kind: 'reply', sentences: [0], target: 0 },
        { kind: 'chatter', sentences: [1] },
      ],
      announcements: [],
      operator: [{ atMs: 13400, action: 'estop' }],
      presentationMs: 10,
      durationMs: 20_000,
    },
  ],
  [
    'TTS 等限流时弹幕回复过期：不等，这一句不播，写回为空',
    {
      seed: 0,
      moderation: { enabled: false, onError: 'skip', delayMs: 0 },
      ttsSlow: false,
      danmaku: [{ atMs: 0, viewer: 0, nickname: 0, text: 0 }],
      outputs: [{ kind: 'reply', sentences: [5], target: 1 }],
      announcements: [{ atMs: 0, sentences: [0], immediate: false }],
      operator: [],
      ttsRpm: 1,
      durationMs: 20_000,
    },
  ],
  [
    'TTS 在句中出错：这一句截断，意图结案，不卡住',
    {
      seed: 0,
      moderation: { enabled: false, onError: 'skip', delayMs: 0 },
      ttsSlow: false,
      danmaku: [],
      outputs: [],
      announcements: [{ atMs: 0, sentences: [7], immediate: false }],
      operator: [],
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

test('TTS 要等限流、额度恢复时弹幕回复已过期：不等，这一句没有在 Stage 上开始', async () => {
  const found = regressions.find(([name]) => name.startsWith('TTS 等限流时弹幕回复过期'));
  assert.ok(found);
  const result = await simulate(found[1]);
  assert.deepEqual(result.violations, []);
  const { trace } = result.history;
  const reply = trace.find((e) => e.kind === 'fact.utterance' && e.data.source === 'danmaku-reply');
  assert.equal(reply?.data.end, 'expired');
  assert.equal(reply?.data.heard, '');
  // 回复 20 秒后过期，额度约 60 秒后才恢复：轮到它时就放弃，不开始等。
  const expired = trace.filter((e) => e.kind === 'tts.rate-expired');
  assert.equal(expired.length, 1);
  assert.equal(expired[0]?.at, reply?.at, '放弃的那一刻发言按过期结束');
  assert.deepEqual(
    trace.filter((e) => e.kind === 'tts.rate-wait'),
    [],
  );
  const id = String(reply?.data.id);
  assert.ok(
    !trace.some((e) => e.kind === 'page.begin' && String(e.data.sentenceId).startsWith(id)),
  );
});

test('崩溃重启后，此前执行中的意图被结案而没有重做', async () => {
  const [, scenario] = regressions[2] as [string, Scenario];
  const result = await simulate(scenario);
  assert.equal(result.restarts, 1);
  const orphaned = result.history.events.filter((e) => e.type === 'intent.orphaned');
  assert.ok(orphaned.length > 0, '重启时应有执行中的意图被标为 unknown');
  const reconciled = result.history.events.filter((e) => e.type === 'intent.reconciled');
  assert.equal(reconciled.length, orphaned.length);
});
