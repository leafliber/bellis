import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Projection } from '@bellis/store';
import { safetyFacade } from '../src/index.ts';
import { request, setup } from './helpers.ts';

/** 写入一个意图并让它停在执行中，然后模拟重启：结果未知。 */
async function orphan(
  s: Awaited<ReturnType<typeof setup>>,
  overrides: Parameters<typeof request>[0],
) {
  const decision = await s.safety.authorize(request(overrides));
  assert.ok(decision.allowed);
  s.store.start(decision.intent.id);
  return decision.intent;
}

test('对账：只列出、只允许所有者（所需能力全都有）为结果未知、没有时效的意图补记结果', async () => {
  const s = await setup();
  try {
    s.safety.requestMode('M1');
    const vote = await orphan(s, {
      key: 'vote:1',
      type: 'vote.start',
      target: 'vote',
      capabilities: ['speech.output'],
      timeSensitive: false,
    });
    const spoken = await orphan(s, { key: 'speech:1#0', type: 'vote.start', timeSensitive: true });
    s.store.recover();
    const owner = safetyFacade(s.safety, 'voter#1', new Set(['speech.output']));
    const stranger = safetyFacade(s.safety, 'other#9', new Set(['obs.scene']));
    // 有时效的意图只能由操作员结案，不在列表里。
    assert.deepEqual(
      owner.unresolved('vote.start').map((i) => i.key),
      ['vote:1'],
    );
    assert.deepEqual(stranger.unresolved('vote.start'), []);
    assert.deepEqual(owner.unresolved('speech.play'), []);
    assert.throws(
      () => stranger.reconcile(vote, { ok: true, result: null }),
      /没有能力 speech\.output/,
    );
    assert.throws(() => owner.reconcile(spoken, { ok: false, error: '没播' }), /只能由操作员结案/);
    // 结案前目标被隔离，结案后解除。
    assert.equal((await s.safety.authorize(request({ target: 'vote' }))).allowed, false);
    const resolved = owner.reconcile(vote, { ok: false, error: '查无记录' });
    assert.equal(resolved.state, 'failed');
    assert.deepEqual(s.events('intent.reconciled').at(-1)?.data, {
      id: vote.id,
      by: 'reconcile',
      error: '查无记录',
    });
    assert.throws(() => owner.reconcile(vote, { ok: true, result: null }), /不是结果未知/);
    assert.equal((await s.safety.authorize(request({ target: 'vote' }))).allowed, true);
  } finally {
    await s.close();
  }
});

test('门面读取宿主注册的投影；没有注册时抛错', async () => {
  const s = await setup();
  try {
    const facade = safetyFacade(s.safety, 'speaker#1');
    const missing: Projection<number> = { name: 'missing', initial: 0, reduce: (n) => n };
    assert.throws(() => facade.view(missing), /未注册/);
  } finally {
    await s.close();
  }
});
