import assert from 'node:assert/strict';
import { test } from 'node:test';
import { danmakuReport, llmReport, spoken } from '../src/readiness.ts';

test('时长的读法', () => {
  assert.equal(spoken(0), '0 秒');
  assert.equal(spoken(45_900), '45 秒');
  assert.equal(spoken(185_000), '3 分 05 秒');
  assert.equal(spoken(2 * 3_600_000 + 3 * 60_000 + 59_000), '2 小时 03 分');
  assert.equal(spoken(-5), '0 秒');
});

test('弹幕接入的状态：缺口不带开始时刻时（回放）只给原因', () => {
  assert.deepEqual(
    danmakuReport(
      {
        subscribe: () => () => {},
        ready: true,
        status: '回放',
        gap: () => ({ reason: '回放的缺口' }),
      },
      1000,
    ),
    {
      ready: true,
      status: '回放',
      gap: { reason: '回放的缺口', startedAt: null, durationMs: null },
    },
  );
});

test('决策模型的状态：还没失败过时最近一次失败为 null', () => {
  assert.deepEqual(
    llmReport({
      complete: async () => '',
      ready: true,
      status: '就绪（还没有调用过）',
      failures: { consecutive: 0 },
    }),
    { ready: true, status: '就绪（还没有调用过）', consecutiveFailures: 0, lastFailure: null },
  );
});
