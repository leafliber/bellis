import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Envelope } from '@bellis/stage';
import { MouthTracker } from '../src/index.ts';

const options = { extrapolateMaxMs: 200, rmsFloor: 0.1, rmsCeiling: 0.3 };
/** 采样率 1000，每窗口 10 个采样：0–99 采样 RMS 0.05（闭嘴），100–199 为 0.2（半开），200–299 为 0.4（全开）。 */
const envelope: Envelope = {
  sampleRate: 1000,
  window: 10,
  rms: [...Array(10).fill(0.05), ...Array(10).fill(0.2), ...Array(10).fill(0.4)],
};

test('口型：按游标在包络上取值并线性映射到 0–1，超出上下限截断', () => {
  const mouth = new MouthTracker(options, (id) => (id === 'a' ? envelope : undefined));
  assert.equal(mouth.value(0), 0);
  mouth.onEvent({ kind: 'started', sentenceId: 'a' }, 0);
  assert.equal(mouth.value(0), 0);
  mouth.onEvent({ kind: 'cursor', sentenceId: 'a', played: 150 }, 1000);
  assert.ok(Math.abs(mouth.value(1000) - 0.5) < 1e-9);
  // 外推 100ms 到采样 250，超过上限 0.3，截到 1。
  assert.equal(mouth.value(1100), 1);
  // 包络之外（还没转发到的位置）闭嘴。
  mouth.onEvent({ kind: 'cursor', sentenceId: 'a', played: 290 }, 2000);
  assert.equal(mouth.value(2050), 0);
});

test('口型：没有包络、截断、页面静音时闭嘴；中途开始跟随也能接上游标', () => {
  const mouth = new MouthTracker(options, (id) => (id === 'a' ? envelope : undefined));
  // 形象启动时句子已在播放：直接从游标接上。
  mouth.onEvent({ kind: 'cursor', sentenceId: 'a', played: 250 }, 0);
  assert.equal(mouth.value(0), 1);
  mouth.onEvent({ kind: 'truncated', sentenceId: 'other', played: 0, reason: 'x' }, 0);
  assert.equal(mouth.value(0), 1);
  mouth.onEvent({ kind: 'truncated', sentenceId: 'a', played: 250, reason: '要求截断' }, 0);
  assert.equal(mouth.value(0), 0);

  mouth.onEvent({ kind: 'cursor', sentenceId: 'a', played: 250 }, 0);
  mouth.onEvent({ kind: 'muted', reason: '宿主心跳丢失' }, 0);
  assert.equal(mouth.value(0), 0);

  mouth.onEvent({ kind: 'started', sentenceId: 'b' }, 0);
  assert.equal(mouth.value(50), 0);
});

test('口型推迟：取 lag 之前的位置；播完推迟 lag 才闭嘴，下一句按自己的开始时刻接上', () => {
  /** 头 50 个采样闭嘴，之后全开。 */
  const second: Envelope = {
    sampleRate: 1000,
    window: 10,
    rms: [...Array(5).fill(0.05), ...Array(25).fill(0.4)],
  };
  const envelopes = new Map([
    ['a', envelope],
    ['b', second],
  ]);
  const mouth = new MouthTracker(options, (id) => envelopes.get(id));
  mouth.onEvent({ kind: 'started', sentenceId: 'a' }, 1000);
  // 开始后的头 60ms 还在推迟里：闭嘴。
  assert.equal(mouth.value(1050, 60), 0);
  mouth.onEvent({ kind: 'cursor', sentenceId: 'a', played: 200 }, 1200);
  // 不推迟时在采样 200（全开）；推迟 60ms 取采样 140（半开），往回推也成立。
  assert.equal(mouth.value(1200), 1);
  assert.ok(Math.abs(mouth.value(1200, 60) - 0.5) < 1e-9);
  // 播完：Stage 不再提供包络，推迟期间用开始时留下的；下一句紧接着开始。
  mouth.onEvent({ kind: 'ended', sentenceId: 'a', played: 300 }, 1300);
  envelopes.delete('a');
  mouth.onEvent({ kind: 'started', sentenceId: 'b' }, 1300);
  assert.equal(mouth.value(1330, 60), 1, '推迟 60ms：仍在 a 的末尾（采样 270）');
  assert.equal(mouth.value(1361, 60), 0, 'a 推迟后也已播完，b 在开头的静音里（采样 1）');
  mouth.onEvent({ kind: 'cursor', sentenceId: 'b', played: 160 }, 1400);
  assert.equal(mouth.value(1400, 60), 1, 'b 的采样 100');
  // 截断不推迟。
  mouth.onEvent({ kind: 'truncated', sentenceId: 'b', played: 100, reason: '要求截断' }, 1400);
  assert.equal(mouth.value(1400, 60), 0);
});

test('口型：ceiling 不大于 floor 时拒绝配置', () => {
  assert.throws(
    () => new MouthTracker({ ...options, rmsCeiling: 0.1 }, () => undefined),
    /rmsCeiling 必须大于 rmsFloor/,
  );
});
