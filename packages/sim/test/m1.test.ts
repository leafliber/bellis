import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpeechService } from '@bellis/speech';
import { World } from '../src/index.ts';
import { chain, entry, played } from './helpers.ts';

const DELAY_MS = 2000;

const say = (id: string, text: string) => ({
  id,
  source: 'chatter' as const,
  text,
  expiresAt: 60_000,
  preempt: 'sentence' as const,
  inputs: [],
  untrusted: false,
});

/** 真实输出（非 sim）下的 M1：审核显式关闭，按需加入放行环节。 */
async function startM1(options: { review: boolean }) {
  const world = new World({
    entries: [
      ...chain({ moderation: { enabled: false } }),
      ...(options.review
        ? [entry('review', 'speech-review', { config: { delayMs: DELAY_MS } })]
        : []),
    ],
    moderationEnabled: false,
    safety: { simulation: false },
  });
  await world.kernel.settled();
  const mode = world.safety.requestMode('M1');
  if (!mode.ok) throw new Error(mode.reason);
  return world;
}

test('M1：每句先等待固定延迟，期满放行后播出', async () => {
  const world = await startM1({ review: true });
  try {
    const startedAt = world.clock.now();
    void world.service(SpeechService).request(say('a', '第一句。第二句。'));
    await world.until(() => played(world).length === 1, 20_000);
    const [a] = played(world);
    assert.equal(a?.end, 'complete');
    assert.equal(a?.heard, '第一句。第二句。');
    assert.equal(world.events('speech.held').length, 2);
    assert.equal(world.events('speech.released').length, 2);
    // 两句各等了一次延迟。
    assert.ok(world.clock.now() - startedAt >= 2 * DELAY_MS);
  } finally {
    await world.close();
  }
});

test('M1：等待中被操作员否决的句子不播出并记入事件，后面的句子照常等待放行', async () => {
  const world = await startM1({ review: true });
  try {
    void world.service(SpeechService).request(say('a', '不该说的话。第二句。'));
    await world.until(() => world.events('speech.held').length === 1);
    world.safety.veto(undefined);
    await world.until(() => played(world).length === 1, 20_000);
    const [a] = played(world);
    assert.equal(a?.heard, '第二句。');
    assert.deepEqual(a?.skipped, [{ index: 0, reason: '操作员否决' }]);
    const vetoed = world.events('speech.vetoed');
    assert.equal(vetoed.length, 1);
    assert.equal((vetoed[0]?.data as { subtitle?: string } | undefined)?.subtitle, '不该说的话。');
    // 被否决的句子没有授权。
    const keys = world.events('intent.authorized').map((e) => (e.data as { key: string }).key);
    assert.ok(!keys.includes('a#0'));
  } finally {
    await world.close();
  }
});

test('M1：只否决指定的句子；急停时等待中的句子都不放行', async () => {
  const world = await startM1({ review: true });
  try {
    void world.service(SpeechService).request(say('a', '第一句。'));
    await world.until(() => world.events('speech.held').length === 1);
    world.safety.veto('other#0');
    assert.equal(world.events('speech.vetoed').length, 0);
    await world.safety.emergencyStop('测试急停');
    await world.until(() => played(world).length === 1, 20_000);
    assert.equal(played(world)[0]?.heard, '');
    assert.equal(world.events('speech.released').length, 0);
    assert.equal(world.events('speech.withdrawn').length, 1);
  } finally {
    await world.close();
  }
});

test('M1：没有放行环节时一句也不播', async () => {
  const world = await startM1({ review: false });
  try {
    void world.service(SpeechService).request(say('a', '第一句。第二句。'));
    await world.until(() => played(world).length === 1, 20_000);
    const [a] = played(world);
    assert.equal(a?.heard, '');
    assert.equal(a?.skipped.length, 2);
    assert.match(a?.skipped[0]?.reason ?? '', /M1 需要逐句放行环节/);
  } finally {
    await world.close();
  }
});
