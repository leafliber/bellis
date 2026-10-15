import assert from 'node:assert/strict';
import { test } from 'node:test';
import { World } from '../src/index.ts';
import { chain, played, speak, startChain } from './helpers.ts';

const hello = { atMs: 0, id: 'd1', viewer: 'v1', nickname: '小明', text: '主播你好' };
const text = '第一句没事。第二句有禁词。第三句也没事。';

test('审核启用：不可说的句子被跳过，其余照常播出', async () => {
  const world = await startChain({
    messages: [hello],
    outputs: [speak(text, 'c-d1')],
    moderation: { enabled: true, blocked: ['禁词'] },
  });
  try {
    await world.until(() => played(world).length === 1);
    const [first] = played(world);
    assert.equal(first?.heard, '第一句没事。第三句也没事。');
    assert.deepEqual(
      first?.skipped.map((s) => s.index),
      [1],
    );
    assert.match(first?.skipped[0]?.reason ?? '', /审核不可说/);
    // 被跳过的句子没有授权，也就没有送到 Stage。
    const keys = world.events('intent.authorized').map((e) => (e.data as { key: string }).key);
    assert.ok(!keys.some((k) => k.endsWith('#1')));
  } finally {
    await world.close();
  }
});

test('判定出错：默认跳过该句；配置为放行时照常播出', async () => {
  for (const [onError, heard] of [
    ['skip', '第一句没事。第三句也没事。'],
    ['pass', text],
  ] as const) {
    const world = await startChain({
      messages: [hello],
      outputs: [speak(text, 'c-d1')],
      moderation: { enabled: true, failOn: ['禁词'], onError },
    });
    try {
      await world.until(() => played(world).length === 1);
      assert.equal(played(world)[0]?.heard, heard);
    } finally {
      await world.close();
    }
  }
});

test('判定超时按出错处理', async () => {
  const world = await startChain({
    messages: [hello],
    outputs: [speak(text, 'c-d1')],
    moderation: { enabled: true, hangOn: ['禁词'] },
  });
  try {
    await world.until(() => played(world).length === 1);
    assert.equal(played(world)[0]?.heard, '第一句没事。第三句也没事。');
    assert.match(played(world)[0]?.skipped[0]?.reason ?? '', /未在 500ms 内完成/);
  } finally {
    await world.close();
  }
});

test('审核关闭：句子直接放行，开关状态记入事件', async () => {
  const world = await startChain({
    messages: [hello],
    outputs: [speak(text, 'c-d1')],
    moderation: { enabled: false, blocked: ['禁词'] },
  });
  try {
    await world.until(() => played(world).length === 1);
    assert.equal(played(world)[0]?.heard, text);
    assert.equal(world.safety.moderationEnabled, false);
    assert.deepEqual(
      world.events('moderation.switched').map((e) => e.data),
      [{ enabled: false }],
    );
    assert.equal(world.kernel.snapshot().find((e) => e.id === 'moderation')?.state, 'disposed');
  } finally {
    await world.close();
  }
});

test('审核已启用但插件不可用时，句子一律跳过（不悄悄放行）', async () => {
  const world = await startChain({
    messages: [hello],
    outputs: [speak(text, 'c-d1')],
    withoutModerationModel: true,
  });
  try {
    assert.equal(world.kernel.snapshot().find((e) => e.id === 'moderation')?.state, 'waiting');
    await world.until(() => played(world).length === 1);
    assert.equal(played(world)[0]?.heard, '');
    assert.ok(played(world)[0]?.skipped.every((s) => s.reason === '审核已启用但审核插件不可用'));
  } finally {
    await world.close();
  }
});

test('审核关闭时无法进入无人值守（M3）', async () => {
  const world = new World({
    entries: chain({ moderation: { enabled: false } }),
    moderationEnabled: false,
    safety: { simulation: false, unattendedGatesSatisfied: true },
  });
  try {
    await world.kernel.settled();
    assert.deepEqual(world.safety.requestMode('M3'), {
      ok: false,
      reason: '审核插件未启用，不允许进入无人值守',
    });
  } finally {
    await world.close();
  }
});
