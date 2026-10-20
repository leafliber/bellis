import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type SpeechRequest, SpeechService } from '@bellis/speech';
import { checkHistory, type World } from '../src/index.ts';
import { played, startChain } from './helpers.ts';

/**
 * 云端 TTS 到每分钟上限时安静等待（R-10）在发声仲裁里的表现：模拟 TTS 的 `rpm` 让一句在返回之前等到窗口里空出名额。
 * 每分钟 1 句：第一句用掉这一分钟的名额，第二句要等到第一句开始合成后 60 秒。
 */

const request = (fields: Partial<SpeechRequest> & Pick<SpeechRequest, 'id' | 'text'>) => ({
  source: 'chatter' as const,
  expiresAt: 120_000,
  preempt: 'sentence' as const,
  inputs: [],
  untrusted: false,
  ...fields,
});

const entries = (world: World, kind: string) => world.trace.filter((e) => e.kind === kind);

/** 两次等待（tts.rate-wait 到 tts.rate-wait-ended）之间 Stage 播出的采样。 */
function playedWhileWaiting(world: World): number {
  let waiting = false;
  let samples = 0;
  for (const entry of world.trace) {
    if (entry.kind === 'tts.rate-wait') waiting = true;
    else if (entry.kind === 'tts.rate-wait-ended') waiting = false;
    else if (entry.kind === 'page.played' && waiting) samples += Number(entry.data.samples);
  }
  return samples;
}

const noViolations = (world: World) =>
  assert.deepEqual(
    checkHistory({ trace: world.trace, events: world.events(), moderationEnabled: true }),
    [],
  );

test('限流等待：等待期间什么也不播，窗口空出名额后照常播出，写回是已播部分', async () => {
  const world = await startChain({ tts: { rpm: 1 } });
  try {
    const speech = world.service(SpeechService);
    void speech.request(request({ id: 'u1', text: '你好。' }));
    void speech.request(request({ id: 'u2', text: '再见。' }));
    await world.until(() => played(world).length === 2, 70_000);
    const [first, second] = played(world);
    assert.equal(first?.heard, '你好。');
    assert.equal(second?.end, 'complete');
    assert.equal(second?.heard, '再见。');
    const [wait] = entries(world, 'tts.rate-wait');
    assert.ok(wait && Number(wait.data.ms) > 55_000, '第二句要等到窗口里空出名额');
    assert.deepEqual(
      entries(world, 'tts.rate-wait-ended').map((e) => e.data.canceled),
      [false],
    );
    const begin = entries(world, 'page.begin').find((e) => e.data.sentenceId === 'u2#0');
    assert.ok(begin && begin.at >= wait.at + Number(wait.data.ms));
    assert.equal(playedWhileWaiting(world), 0);
    noViolations(world);
  } finally {
    await world.close();
  }
});

test('限流等待中发言过期：等待随之取消，这一句不播出，发言按过期结束', async () => {
  const world = await startChain({ tts: { rpm: 1 } });
  try {
    const speech = world.service(SpeechService);
    void speech.request(request({ id: 'u1', text: '你好。' }));
    void speech.request(request({ id: 'u2', text: '再见。', expiresAt: 5000 }));
    await world.until(() => played(world).length === 2, 10_000);
    const second = played(world)[1];
    assert.equal(second?.id, 'u2');
    assert.equal(second?.end, 'expired');
    assert.equal(second?.heard, '');
    const [ended] = entries(world, 'tts.rate-wait-ended');
    assert.equal(ended?.data.canceled, true);
    assert.ok(ended && ended.at >= 5000 && ended.at < 5100, '过期那一刻取消等待');
    await world.run(70_000, 100);
    assert.equal(
      entries(world, 'page.begin').filter((e) => String(e.data.sentenceId).startsWith('u2#'))
        .length,
      0,
    );
    noViolations(world);
  } finally {
    await world.close();
  }
});

test('限流等待中急停：等待随之取消，安全停止期间不播', async () => {
  const world = await startChain({ tts: { rpm: 1 } });
  try {
    const speech = world.service(SpeechService);
    void speech.request(request({ id: 'u1', text: '你好。' }));
    void speech.request(request({ id: 'u2', text: '再见。' }));
    await world.until(() => entries(world, 'tts.rate-wait').length === 1);
    void world.safety.emergencyStop('仿真急停');
    await world.until(() => played(world).length === 2);
    assert.equal(played(world)[1]?.end, 'stopped');
    assert.deepEqual(
      entries(world, 'tts.rate-wait-ended').map((e) => e.data.canceled),
      [true],
    );
    await world.run(70_000, 100);
    noViolations(world);
  } finally {
    await world.close();
  }
});

test('限流等待中被定时播报抢占：等待立即取消；播报也要等名额，等到过期就不播', async () => {
  // 定时播报到点后 30 秒内没播出就过期，短于这一分钟剩下的等待。
  const world = await startChain({
    tts: { rpm: 1 },
    announcements: [{ id: 'hour', atMs: 2000, text: '整点提醒。' }],
  });
  try {
    const speech = world.service(SpeechService);
    void speech.request(request({ id: 'u1', text: '你好。' }));
    void speech.request(request({ id: 'u2', text: '再见。' }));
    await world.until(() => played(world).length === 3, 40_000);
    const [, chatter, announcement] = played(world);
    assert.equal(chatter?.id, 'u2');
    assert.equal(chatter?.end, 'preempted');
    assert.equal(announcement?.id, 'scheduled:hour');
    assert.equal(announcement?.end, 'expired');
    const ended = entries(world, 'tts.rate-wait-ended');
    assert.deepEqual(
      ended.map((e) => e.data.canceled),
      [true, true],
    );
    assert.equal(ended[0]?.at, 2000, '抢占那一刻取消等待');
    assert.ok((ended[1]?.at ?? 0) >= 32_000, '播报等到过期才取消');
    noViolations(world);
  } finally {
    await world.close();
  }
});
