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
async function startM1(options: { review: boolean; config?: Record<string, unknown> }) {
  const world = new World({
    entries: [
      ...chain({ moderation: { enabled: false } }),
      ...(options.review
        ? [
            entry('review', 'speech-review', {
              config: options.config ?? { delayMs: DELAY_MS },
            }),
          ]
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

/** 每句等待恰好以一个结束事件结束：放行、否决或撤回。 */
function assertOneEnding(world: World) {
  const held = world.events('speech.held').map((e) => (e.data as { key: string }).key);
  const endings = new Map<string, number>();
  for (const type of ['speech.released', 'speech.vetoed', 'speech.withdrawn']) {
    for (const event of world.events(type)) {
      const key = (event.data as { key: string }).key;
      endings.set(key, (endings.get(key) ?? 0) + 1);
    }
  }
  assert.deepEqual([...endings.keys()].sort(), [...held].sort());
  assert.ok([...endings.values()].every((count) => count === 1));
}

const APPROVE = { mode: 'approve', approveTimeoutMs: 5000 };

test('M1 逐句放行：不放行就一直等，操作员放行后才播出，放行记为操作员放行', async () => {
  const world = await startM1({ review: true, config: APPROVE });
  try {
    void world.service(SpeechService).request(say('a', '第一句。'));
    await world.until(() => world.events('speech.held').length === 1);
    assert.deepEqual(world.events('speech.held')[0]?.data, {
      key: 'a#0',
      utteranceId: 'a',
      index: 0,
      source: 'chatter',
      subtitle: '第一句。',
      mode: 'approve',
      timeoutMs: 5000,
    });
    await world.run(4000);
    assert.equal(played(world).length, 0);
    assert.equal(world.events('speech.released').length, 0);
    world.safety.release('a#0');
    await world.until(() => played(world).length === 1, 20_000);
    assert.equal(played(world)[0]?.heard, '第一句。');
    assert.deepEqual(
      world.events('speech.released').map((e) => e.data),
      [{ key: 'a#0', by: 'operator' }],
    );
    assertOneEnding(world);
  } finally {
    await world.close();
  }
});

test('M1 逐句放行：否决的句子不播；等待超时撤回、不播出，原因写明超时', async () => {
  const world = await startM1({ review: true, config: APPROVE });
  try {
    void world.service(SpeechService).request(say('a', '第一句。第二句。'));
    await world.until(() => world.events('speech.held').length === 1);
    world.safety.veto(undefined);
    await world.until(() => world.events('speech.held').length === 2);
    await world.until(() => played(world).length === 1, 20_000);
    const [a] = played(world);
    assert.equal(a?.heard, '');
    assert.deepEqual(a?.skipped, [
      { index: 0, reason: '操作员否决' },
      { index: 1, reason: '等待放行超时（5000ms）' },
    ]);
    assert.deepEqual(
      world.events('speech.withdrawn').map((e) => e.data),
      [{ key: 'a#1', reason: '等待放行超时（5000ms）', timedOut: true }],
    );
    assertOneEnding(world);
  } finally {
    await world.close();
  }
});

test('M1 逐句放行：模式变化与急停时等待中的句子撤回，不播出', async () => {
  const world = await startM1({ review: true, config: APPROVE });
  try {
    void world.service(SpeechService).request(say('a', '第一句。'));
    await world.until(() => world.events('speech.held').length === 1);
    world.safety.confirmPresence();
    assert.ok(world.safety.requestMode('M2').ok);
    await world.until(() => played(world).length === 1, 20_000);
    assert.equal(played(world)[0]?.heard, '');
    assert.deepEqual(
      world.events('speech.withdrawn').map((e) => e.data),
      [{ key: 'a#0', reason: '监督模式已切到 M2' }],
    );

    assert.ok(world.safety.requestMode('M1').ok);
    void world.service(SpeechService).request(say('b', '第二句。'));
    await world.until(() => world.events('speech.held').length === 2);
    await world.safety.emergencyStop('测试急停');
    await world.until(() => played(world).length === 2, 20_000);
    assert.equal(played(world)[1]?.heard, '');
    assert.equal(world.events('speech.released').length, 0);
    assert.equal(world.events('speech.withdrawn').length, 2);
    assertOneEnding(world);
  } finally {
    await world.close();
  }
});

test('M1 固定延迟：操作员可以提前放行，放行全部等待中的句子', async () => {
  const world = await startM1({ review: true, config: { mode: 'delay', delayMs: 60_000 } });
  try {
    const startedAt = world.clock.now();
    void world.service(SpeechService).request(say('a', '第一句。'));
    await world.until(() => world.events('speech.held').length === 1);
    const held = world.events('speech.held')[0]?.data as { mode: string } | undefined;
    assert.equal(held?.mode, 'delay');
    world.safety.release(undefined);
    await world.until(() => played(world).length === 1, 20_000);
    assert.equal(played(world)[0]?.heard, '第一句。');
    assert.ok(world.clock.now() - startedAt < 60_000);
    assert.deepEqual(
      world.events('speech.released').map((e) => e.data),
      [{ key: 'a#0', by: 'operator' }],
    );
    assertOneEnding(world);
  } finally {
    await world.close();
  }
});

test('M1 固定延迟期满放行时记为延迟放行', async () => {
  const world = await startM1({ review: true });
  try {
    void world.service(SpeechService).request(say('a', '第一句。'));
    await world.until(() => played(world).length === 1, 20_000);
    assert.deepEqual(
      world.events('speech.released').map((e) => e.data),
      [{ key: 'a#0', by: 'delay' }],
    );
  } finally {
    await world.close();
  }
});

test('OBS 外部切到安全场景（仿真）：M1 下记事实并走急停，应急动作再做一遍', async () => {
  const world = await startM1({ review: true });
  try {
    world.obs.external({ kind: 'scene', sceneName: 'Safe' });
    await world.flush();
    assert.equal(world.safety.mode, 'safe-stop');
    assert.deepEqual(
      world.events('safety.obs-external').map((e) => e.data),
      [{ change: 'scene', scene: 'Safe', resync: false, mode: 'M1' }],
    );
    assert.deepEqual(
      world.events('safety.emergency-requested').map((e) => (e.data as { reason: string }).reason),
      ['OBS 外部切到安全场景'],
    );
    assert.equal(world.obs.runs.length, 1);
    assert.ok(world.obs.muted.has('Stage'));
  } finally {
    await world.close();
  }
});
