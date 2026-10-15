import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type FromPage, type PageLink, StagePageService } from '@bellis/stage';
import { World } from '../src/index.ts';
import { entry } from './helpers.ts';

/** 只装模拟 Stage 页面，直接通过链路驱动它。 */
async function page(config: Record<string, unknown> = {}) {
  const world = new World({
    entries: [entry('stage-page', 'stage-page-sim', { config })],
    moderationEnabled: false,
  });
  await world.kernel.settled();
  const link: PageLink = world.service(StagePageService);
  const events: FromPage[] = [];
  link.onMessage((m) => {
    if (m.kind !== 'heartbeat-ack') events.push(m);
  });
  const beat = () => link.send({ kind: 'heartbeat' });
  return { world, link, events, beat };
}

const frame = (n: number) => new Int16Array(n);

test('欠载时补零，补零不推进播放游标', async () => {
  const p = await page();
  try {
    p.beat();
    p.link.send({ kind: 'token', token: 1, ttlMs: 10_000 });
    p.link.send({ kind: 'begin', sentenceId: 's', token: 1, subtitle: '你好', sampleRate: 16_000 });
    p.link.send({ kind: 'audio', sentenceId: 's', token: 1, pcm: frame(640) });
    await p.world.run(100);
    const cursors = p.events
      .filter((e) => e.kind === 'cursor')
      .map((e) => (e as { played: number }).played);
    assert.deepEqual(cursors, [320, 640]);
    assert.ok(p.events.some((e) => e.kind === 'underrun' && e.played === 640));
    p.beat();
    p.link.send({ kind: 'audio', sentenceId: 's', token: 1, pcm: frame(320) });
    p.link.send({ kind: 'end', sentenceId: 's', token: 1 });
    await p.world.run(40);
    assert.deepEqual(p.events.at(-1), { kind: 'ended', sentenceId: 's', played: 960 });
  } finally {
    await p.world.close();
  }
});

test('令牌变化时丢弃旧令牌的缓冲，之后带旧令牌的音频也被丢弃', async () => {
  const p = await page();
  try {
    p.beat();
    p.link.send({ kind: 'token', token: 1, ttlMs: 10_000 });
    p.link.send({ kind: 'begin', sentenceId: 's1', token: 1, subtitle: 'a', sampleRate: 16_000 });
    p.link.send({ kind: 'audio', sentenceId: 's1', token: 1, pcm: frame(16_000) });
    await p.world.run(20);
    p.link.send({ kind: 'token', token: 2, ttlMs: 10_000 });
    assert.deepEqual(p.events.at(-1), {
      kind: 'truncated',
      sentenceId: 's1',
      played: 320,
      reason: '令牌已变化',
    });
    p.link.send({ kind: 'begin', sentenceId: 's2', token: 1, subtitle: 'b', sampleRate: 16_000 });
    p.link.send({ kind: 'audio', sentenceId: 's2', token: 1, pcm: frame(320) });
    await p.world.run(100);
    // 旧令牌的句子被拒收并回报截断，从未开始播放。
    assert.deepEqual(
      p.events.filter((e) => 'sentenceId' in e && e.sentenceId === 's2'),
      [{ kind: 'truncated', sentenceId: 's2', played: 0, reason: '令牌无效' }],
    );
  } finally {
    await p.world.close();
  }
});

test('许可在时长内没有续约即过期，页面自己停止', async () => {
  const p = await page();
  try {
    p.link.send({ kind: 'token', token: 1, ttlMs: 100 });
    p.link.send({ kind: 'begin', sentenceId: 's', token: 1, subtitle: 'a', sampleRate: 16_000 });
    p.link.send({ kind: 'audio', sentenceId: 's', token: 1, pcm: frame(16_000) });
    for (let i = 0; i < 5; i += 1) {
      p.beat();
      await p.world.run(40);
    }
    const truncated = p.events.find((e) => e.kind === 'truncated');
    assert.equal(truncated && 'reason' in truncated ? truncated.reason : undefined, '许可过期');
  } finally {
    await p.world.close();
  }
});

test('收不到宿主心跳时自行静音并清空缓冲，再次收到心跳后恢复', async () => {
  const p = await page({ heartbeatTimeoutMs: 200 });
  try {
    p.beat();
    p.link.send({ kind: 'token', token: 1, ttlMs: 60_000 });
    p.link.send({ kind: 'begin', sentenceId: 's', token: 1, subtitle: 'a', sampleRate: 16_000 });
    p.link.send({ kind: 'audio', sentenceId: 's', token: 1, pcm: frame(16_000) });
    await p.world.run(300);
    assert.ok(p.events.some((e) => e.kind === 'muted'));
    assert.ok(p.events.some((e) => e.kind === 'truncated' && e.reason === '宿主心跳丢失'));
    p.link.send({ kind: 'begin', sentenceId: 's2', token: 1, subtitle: 'b', sampleRate: 16_000 });
    await p.world.run(100);
    assert.deepEqual(
      p.events.filter((e) => 'sentenceId' in e && e.sentenceId === 's2'),
      [{ kind: 'truncated', sentenceId: 's2', played: 0, reason: '页面已静音' }],
      '静音期间不接受新的句子，并回报截断',
    );
    p.beat();
    p.link.send({ kind: 'begin', sentenceId: 's3', token: 1, subtitle: 'c', sampleRate: 16_000 });
    p.link.send({ kind: 'audio', sentenceId: 's3', token: 1, pcm: frame(320) });
    await p.world.run(20);
    assert.ok(p.events.some((e) => e.kind === 'started' && e.sentenceId === 's3'));
  } finally {
    await p.world.close();
  }
});

test('页面不应答心跳时 Stage 服务报告失败，安全核走急停路径', async () => {
  const world = new World({
    entries: [
      entry('stage-page', 'stage-page-sim'),
      entry('stage', 'stage-service', { config: { pageTimeoutMs: 300 } }),
    ],
    moderationEnabled: false,
  });
  try {
    await world.kernel.settled();
    world.safety.requestMode('M0');
    // 让页面失去响应：停用页面插件（模拟 OBS 浏览器源卡死）。
    await world.kernel.disable('stage-page');
    await world.run(600);
    assert.equal(world.safety.mode, 'safe-stop');
    assert.equal(world.obs.currentScene, 'Safe');
  } finally {
    await world.close();
  }
});
