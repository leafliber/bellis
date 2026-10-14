import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  executeIntent,
  executeOnce,
  openSqlite,
  payloadHash,
  ResourceIsolated,
  StateStore,
  StoreUnavailable,
} from '../src/index.ts';
import { base, counter, counts, fold, intent, tempDb } from './helpers.ts';

test('事件只追加，投影与事件同事务更新，重启后从事件重建', () => {
  const db = tempDb();
  try {
    let store = StateStore.open({ path: db.path, projections: [counts], now: counter() });
    store.append('vote.opened', { id: 1 });
    store.append('vote.closed', { id: 1 });
    store.append('vote.opened', { id: 2 });
    assert.deepEqual(store.view(counts), { 'vote.opened': 2, 'vote.closed': 1 });
    store.close();

    // 篡改库中保存的投影，重启后仍以事件为准。
    const raw = openSqlite(db.path);
    raw.prepare("UPDATE projections SET state = '{}' WHERE name = 'counts'").run();
    assert.throws(() => raw.prepare("UPDATE events SET type = 'x'").run(), /append-only/);
    assert.throws(() => raw.prepare('DELETE FROM events').run(), /append-only/);
    raw.close();

    store = StateStore.open({ path: db.path, projections: [counts] });
    assert.deepEqual(store.view(counts), { 'vote.opened': 2, 'vote.closed': 1 });
    store.close();
  } finally {
    db.cleanup();
  }
});

test('事务内任何一步失败都整体回滚，投影不变，订阅者不收到通知', () => {
  const db = tempDb();
  const store = StateStore.open({ path: db.path, projections: [counts] });
  try {
    const seen: string[] = [];
    store.subscribe((event) => seen.push(event.type));
    assert.throws(() =>
      store.transaction((tx) => {
        tx.append('a.done', {});
        throw new Error('中途失败');
      }),
    );
    assert.deepEqual(store.view(counts), {});
    assert.equal(store.events().length, 0);
    store.append('b.done', {});
    assert.deepEqual(seen, ['b.done']);
  } finally {
    store.close();
    db.cleanup();
  }
});

test('同一幂等键只执行一次；载荷不同则拒绝', async () => {
  const db = tempDb();
  const store = StateStore.open({ path: db.path });
  try {
    let runs = 0;
    const effect = async () => {
      runs += 1;
      return { played: true };
    };
    const first = await executeOnce(store, base('k1'), { key: 'k1' }, effect);
    const second = await executeOnce(store, base('k1'), { key: 'k1' }, effect);
    assert.equal(runs, 1);
    assert.equal(first.executed, true);
    assert.equal(second.executed, false);
    assert.equal(second.intent.state, 'succeeded');
    assert.deepEqual(second.intent.result, { played: true });
    assert.throws(
      () => store.authorize(intent('k1', { payloadHash: 'other' })),
      /已用于不同的意图/,
    );
  } finally {
    store.close();
    db.cleanup();
  }
});

test('副作用失败时记为失败，不重试', async () => {
  const db = tempDb();
  const store = StateStore.open({ path: db.path });
  try {
    const { intent: failed } = await executeOnce(store, base('k'), { key: 'k' }, async () => {
      throw new Error('设备拒绝');
    });
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error, '设备拒绝');
    const again = await executeOnce(store, base('k'), { key: 'k' }, async () =>
      assert.fail('不应重做'),
    );
    assert.equal(again.executed, false);
  } finally {
    store.close();
    db.cleanup();
  }
});

test('意图状态只能按规定方向变化', () => {
  const db = tempDb();
  const store = StateStore.open({ path: db.path });
  try {
    const { intent: created } = store.authorize(intent('k'));
    assert.throws(() => store.succeed(created.id, null), /不能从 pending 变为 succeeded/);
    store.start(created.id);
    store.succeed(created.id, null);
    assert.throws(() => store.fail(created.id, 'x'), /不能从 succeeded 变为 failed/);
    assert.throws(
      () => store.resolve(created.id, { ok: true, result: null }, 'operator'),
      /不是 unknown/,
    );
  } finally {
    store.close();
    db.cleanup();
  }
});

test('重启恢复：未开始的放弃，执行中的标为 unknown，可人工结案', () => {
  const db = tempDb();
  try {
    let store = StateStore.open({ path: db.path });
    const pending = store.authorize(intent('pending')).intent;
    const running = store.authorize(
      intent('running', { timeSensitive: false, type: 'vote.open' }),
    ).intent;
    store.start(running.id);
    store.close();

    store = StateStore.open({ path: db.path });
    const report = store.recover();
    assert.deepEqual(
      report.abandoned.map((i) => [i.id, i.state]),
      [[pending.id, 'failed']],
    );
    assert.deepEqual(
      report.orphaned.map((i) => [i.id, i.state]),
      [[running.id, 'unknown']],
    );
    assert.deepEqual(
      store.intentsIn('unknown').map((i) => i.key),
      ['running'],
    );

    const resolved = store.resolve(
      running.id,
      { ok: true, result: { tally: [3, 1] } },
      'reconcile',
    );
    assert.equal(resolved.state, 'succeeded');
    assert.equal(store.events().at(-1)?.type, 'intent.reconciled');
    store.close();
  } finally {
    db.cleanup();
  }
});

test('许可令牌只增不减，重启后不回退', () => {
  const db = tempDb();
  try {
    let store = StateStore.open({ path: db.path });
    assert.equal(store.token('stage.audio'), 0);
    assert.equal(store.nextToken('stage.audio'), 1);
    assert.equal(store.nextToken('stage.audio'), 2);
    assert.equal(store.nextToken('game.input'), 1);
    store.close();

    const raw = openSqlite(db.path);
    assert.throws(
      () => raw.prepare("UPDATE lease_tokens SET token = 1 WHERE resource = 'stage.audio'").run(),
      /must increase/,
    );
    assert.throws(() => raw.prepare('DELETE FROM lease_tokens').run(), /never removed/);
    raw.close();

    store = StateStore.open({ path: db.path });
    assert.equal(store.token('stage.audio'), 2);
    assert.equal(store.nextToken('stage.audio'), 3);
    store.close();
  } finally {
    db.cleanup();
  }
});

test('存储故障后进入不可用状态，新的写入一律拒绝，读取仍可用', () => {
  const db = tempDb();
  const faults: Error[] = [];
  let fail = false;
  const store = StateStore.open({
    path: db.path,
    projections: [counts],
    onFault: (error) => faults.push(error),
    fault: (point) => {
      if (fail && point === 'append:before-commit') {
        throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
      }
    },
  });
  try {
    store.append('a.done', {});
    fail = true;
    assert.throws(() => store.append('b.done', {}), StoreUnavailable);
    assert.equal(store.healthy, false);
    assert.equal(faults.length, 1);
    fail = false;
    assert.throws(() => store.authorize(intent('k')), StoreUnavailable);
    assert.deepEqual(store.view(counts), { 'a.done': 1 });
    assert.equal(store.events().length, 1);
  } finally {
    store.close();
    db.cleanup();
  }
});

test('投影与库中事件始终一致', () => {
  const db = tempDb();
  const store = StateStore.open({ path: db.path, projections: [counts] });
  try {
    for (let i = 0; i < 20; i += 1) store.append(`t${i % 3}.done`, { i });
    assert.deepEqual(store.view(counts), fold(counts, store.events()));
  } finally {
    store.close();
    db.cleanup();
  }
});

test('执行前核对载荷：与授权时不一致则拒绝执行', async () => {
  const db = tempDb();
  const store = StateStore.open({ path: db.path });
  try {
    const { intent: authorized } = store.authorize({
      ...base('k'),
      payloadHash: payloadHash({ text: 'A' }),
    });
    await assert.rejects(
      executeIntent(store, authorized, { text: 'B' }, async () => assert.fail('不应执行')),
      /载荷与授权时不一致/,
    );
    assert.equal(store.intent(authorized.id)?.state, 'pending');
    let seen: unknown;
    await executeIntent(store, authorized, { text: 'A' }, async (payload) => {
      seen = payload;
    });
    assert.deepEqual(seen, { text: 'A' });
  } finally {
    store.close();
    db.cleanup();
  }
});

test('同一幂等键但目标等任何授权字段不同都视为篡改', () => {
  const db = tempDb();
  const store = StateStore.open({ path: db.path });
  try {
    store.authorize(intent('k'));
    assert.throws(() => store.authorize(intent('k', { target: 'elsewhere' })), /已用于不同的意图/);
    assert.throws(
      () => store.authorize(intent('k', { capabilities: ['obs.scene'] })),
      /已用于不同的意图/,
    );
    assert.throws(() => store.authorize(intent('k', { timeSensitive: false })), /已用于不同的意图/);
    assert.equal(store.authorize(intent('k')).duplicate, true);
  } finally {
    store.close();
    db.cleanup();
  }
});

test('目标上有结果未知的意图时，存储层同样拒绝新的意图', () => {
  const db = tempDb();
  const store = StateStore.open({ path: db.path });
  try {
    const { intent: first } = store.authorize(intent('a'));
    store.start(first.id);
    store.recover();
    assert.throws(() => store.authorize(intent('b')), ResourceIsolated);
    assert.equal(store.authorize(intent('c', { target: 'chat' })).duplicate, false);
    store.resolve(first.id, { ok: false, error: '操作员确认未播出' }, 'operator');
    assert.equal(store.authorize(intent('b')).duplicate, false);
  } finally {
    store.close();
    db.cleanup();
  }
});

test('有时效的意图只能由操作员结案', () => {
  const db = tempDb();
  const store = StateStore.open({ path: db.path });
  try {
    const { intent: spoken } = store.authorize(intent('speech'));
    store.start(spoken.id);
    store.recover();
    assert.throws(
      () => store.resolve(spoken.id, { ok: true, result: null }, 'reconcile'),
      /只能由操作员结案/,
    );
    assert.equal(
      store.resolve(spoken.id, { ok: true, result: null }, 'operator').state,
      'succeeded',
    );
  } finally {
    store.close();
    db.cleanup();
  }
});

test('读取时遇到存储故障同样进入不可用状态', () => {
  const db = tempDb();
  let broken = false;
  const store = StateStore.open({
    path: db.path,
    fault: (point) => {
      if (broken && point === 'read') {
        throw Object.assign(new Error('disk I/O error'), {
          code: 'ERR_SQLITE_ERROR',
          errcode: 266,
        });
      }
    },
  });
  try {
    broken = true;
    assert.throws(() => store.events(), StoreUnavailable);
    broken = false;
    assert.equal(store.healthy, false);
    assert.throws(() => store.append('a.done', {}), StoreUnavailable);
  } finally {
    store.close();
    db.cleanup();
  }
});

test('投影状态冻结，调用方不能原地修改', () => {
  const db = tempDb();
  const store = StateStore.open({ path: db.path, projections: [counts] });
  try {
    store.append('a.done', {});
    const view = store.view(counts);
    assert.throws(() => {
      (view as Record<string, number>)['a.done'] = 99;
    }, TypeError);
    assert.deepEqual(store.view(counts), { 'a.done': 1 });
  } finally {
    store.close();
    db.cleanup();
  }
});
