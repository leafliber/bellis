import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latencyHintOf, latencyStats, statsEveryOf } from '../page/diagnostics.js';
import { isPageStats } from '../src/index.ts';

test('片段：缺省 interactive、不回报；只认 playback 与 100–60000ms 的整数间隔', () => {
  const of = (hash: string) => new URLSearchParams(hash);
  assert.equal(latencyHintOf(of('t=x')), 'interactive');
  assert.equal(latencyHintOf(of('t=x&l=playback')), 'playback');
  assert.equal(latencyHintOf(of('t=x&l=balanced')), 'interactive');
  assert.equal(statsEveryOf(of('t=x')), 0);
  assert.equal(statsEveryOf(of('s=500')), 500);
  assert.equal(statsEveryOf(of('s=50')), 0);
  assert.equal(statsEveryOf(of('s=1.5')), 0);
  assert.equal(statsEveryOf(of('s=abc')), 0);
});

test('页面的 stats 符合宿主的 Schema；浏览器不提供的值为 null', () => {
  const context = {
    sampleRate: 192_000,
    baseLatency: 0.02,
    outputLatency: Number.NaN,
    currentTime: 3.2,
    getOutputTimestamp: () => ({ contextTime: 3.12, performanceTime: undefined }),
  } as unknown as Parameters<typeof latencyStats>[0];
  const stats = latencyStats(context, 'playback');
  assert.ok(isPageStats.Check(JSON.parse(JSON.stringify(stats))));
  assert.equal(stats.outputLatency, null);
  assert.equal(stats.outputPerformanceTime, null);
  assert.equal(stats.outputContextTime, 3.12);
});
