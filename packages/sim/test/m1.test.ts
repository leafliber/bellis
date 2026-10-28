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

test('M1：给句键的否决只跳过那一句，记入事件，后面的句子照常等待放行', async () => {
  const world = await startM1({ review: true });
  try {
    void world.service(SpeechService).request(say('a', '不该说的话。第二句。'));
    await world.until(() => world.events('speech.held').length === 1);
    world.safety.veto('a#0');
    await world.until(() => played(world).length === 1, 20_000);
    const [a] = played(world);
    assert.equal(a?.end, 'complete');
    assert.equal(a?.heard, '第二句。');
    assert.deepEqual(a?.skipped, [{ index: 0, reason: '操作员否决' }]);
    const vetoed = world.events('speech.vetoed');
    assert.equal(vetoed.length, 1);
    assert.equal((vetoed[0]?.data as { subtitle?: string } | undefined)?.subtitle, '不该说的话。');
    assert.equal((vetoed[0]?.data as { abandoned?: boolean } | undefined)?.abandoned, undefined);
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
    world.safety.veto('a#0');
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

const keysOf = (world: World, type: string) =>
  world.events(type).map((e) => (e.data as { key: string }).key);

/**
 * 发言 a 的第 2 句（a#1）在等待中被全部否决之后的共同核对：只有这一句记 `speech.vetoed`（带 abandoned）与
 * `sentence.skipped`；发言按 stopped 结束，写回只含已播出的第 1 句，`skipped` 只列被否决的那一句。
 * 剩下的句子没有进入等待、没有授权，由各个测试按句键核对。
 */
function assertSecondVetoedAll(world: World) {
  const [a] = played(world);
  assert.equal(a?.end, 'stopped');
  assert.equal(a?.reason, '操作员否决');
  assert.equal(a?.heard, '第一句。');
  assert.deepEqual(a?.skipped, [{ index: 1, reason: '操作员否决' }]);
  assert.deepEqual(
    world.events('speech.vetoed').map((e) => e.data),
    [
      {
        key: 'a#1',
        utteranceId: 'a',
        index: 1,
        source: 'chatter',
        subtitle: '第二句。',
        reason: '操作员否决',
        abandoned: true,
      },
    ],
  );
  assert.deepEqual(
    world.events('sentence.skipped').map((e) => e.data),
    [{ utteranceId: 'a', index: 1, reason: '操作员否决' }],
  );
  assertOneEnding(world);
}

test('M1 逐句放行：全部否决放弃这段发言剩下的句子，写回只含已播出的部分；下一段发言照常', async () => {
  const world = await startM1({ review: true, config: APPROVE });
  try {
    void world.service(SpeechService).request(say('a', '第一句。第二句。第三句。'));
    await world.until(() => world.events('speech.held').length === 1);
    world.safety.release('a#0');
    await world.until(() => world.events('speech.held').length === 2, 20_000);
    world.safety.veto(undefined);
    await world.until(() => played(world).length === 1, 20_000);
    // 之后再等也没有句子进入等待（approve 的等待上限是 5 秒）。
    await world.run(10_000);
    assert.deepEqual(keysOf(world, 'speech.held'), ['a#0', 'a#1']);
    assert.deepEqual(keysOf(world, 'intent.authorized'), ['a#0']);
    assertSecondVetoedAll(world);

    // 放弃的只是那一段发言：下一段照常逐句等待放行。
    void world.service(SpeechService).request(say('b', '下一段。'));
    await world.until(() => world.events('speech.held').length === 3);
    world.safety.release('b#0');
    await world.until(() => played(world).length === 2, 20_000);
    assert.equal(played(world)[1]?.end, 'complete');
    assert.equal(played(world)[1]?.heard, '下一段。');
  } finally {
    await world.close();
  }
});

test('M1 固定延迟：全部否决放弃这段发言剩下的句子，它们不会到点自动放行', async () => {
  const world = await startM1({ review: true });
  try {
    void world.service(SpeechService).request(say('a', '第一句。第二句。第三句。'));
    // 第 1 句期满放行并播出，第 2 句进入等待时全部否决。
    await world.until(() => world.events('speech.held').length === 2, 20_000);
    assert.deepEqual(
      world.events('speech.released').map((e) => e.data),
      [{ key: 'a#0', by: 'delay' }],
    );
    world.safety.veto(undefined);
    await world.until(() => played(world).length === 1, 20_000);
    await world.run(3 * DELAY_MS);
    assert.deepEqual(keysOf(world, 'speech.held'), ['a#0', 'a#1']);
    assert.deepEqual(keysOf(world, 'intent.authorized'), ['a#0']);
    assert.equal(world.events('speech.released').length, 1);
    assertSecondVetoedAll(world);
  } finally {
    await world.close();
  }
});

test('M1：此刻没有句子在等待时，全部否决什么也不做', async () => {
  const world = await startM1({ review: true, config: APPROVE });
  try {
    // 还没有发言时。
    world.safety.veto(undefined);
    void world.service(SpeechService).request(say('a', '第一句。第二句。'));
    await world.until(() => world.events('speech.held').length === 1);
    world.safety.release('a#0');
    // 第 1 句已放行、第 2 句还没进入等待时。
    world.safety.veto(undefined);
    await world.until(() => world.events('speech.held').length === 2, 20_000);
    world.safety.release('a#1');
    await world.until(() => played(world).length === 1, 20_000);
    assert.equal(world.events('speech.vetoed').length, 0);
    const [a] = played(world);
    assert.equal(a?.end, 'complete');
    assert.equal(a?.heard, '第一句。第二句。');
    assert.deepEqual(a?.skipped, []);
    assertOneEnding(world);
  } finally {
    await world.close();
  }
});

/** 记下读了几段、是否被叫停的文本流；每段一句，读取方要就给。 */
function countedText(chunks: readonly string[]) {
  const reads = { pulls: 0, returned: false };
  const text: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        const value = chunks[reads.pulls];
        reads.pulls += 1;
        return value === undefined
          ? { done: true as const, value: undefined }
          : { done: false as const, value };
      },
      return: async () => {
        reads.returned = true;
        return { done: true as const, value: undefined };
      },
    }),
  };
  return { text, reads };
}

test('M1：文本为流时，给句键的否决照常读下一段；全部否决之后不再读流的下一段', async () => {
  const world = await startM1({ review: true, config: APPROVE });
  try {
    const speech = world.service(SpeechService);
    const single = countedText(['第一句。', '第二句。']);
    void speech.request({ ...say('a', ''), text: single.text });
    await world.until(() => world.events('speech.held').length === 1);
    world.safety.veto('a#0');
    await world.until(() => world.events('speech.held').length === 2, 20_000);
    assert.equal(single.reads.pulls, 2);
    world.safety.release('a#1');
    await world.until(() => played(world).length === 1, 20_000);
    assert.equal(played(world)[0]?.heard, '第二句。');

    const all = countedText(['第一句。', '第二句。', '第三句。']);
    void speech.request({ ...say('b', ''), text: all.text });
    await world.until(() => world.events('speech.held').length === 3);
    assert.equal(all.reads.pulls, 1);
    world.safety.veto(undefined);
    await world.until(() => played(world).length === 2, 20_000);
    await world.run(10_000);
    // 只读了第一段：放弃之后叫停了流，不再读下一段。
    assert.deepEqual(all.reads, { pulls: 1, returned: true });
    assert.deepEqual(keysOf(world, 'speech.held'), ['a#0', 'a#1', 'b#0']);
    const b = played(world)[1];
    assert.equal(b?.end, 'stopped');
    assert.equal(b?.heard, '');
    assert.deepEqual(b?.skipped, [{ index: 0, reason: '操作员否决' }]);
    assertOneEnding(world);
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
