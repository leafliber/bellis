import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './helpers.ts';

test('只在输出模式下、对有能力的持有者授予许可', async () => {
  const s = await setup();
  try {
    assert.deepEqual(s.safety.grant('speaker#1', 'stage.audio'), {
      ok: false,
      reason: '安全停止中，不产生新输出',
    });
    s.safety.requestMode('M1');
    assert.deepEqual(s.safety.grant('speaker#1', 'game.input'), {
      ok: false,
      reason: 'speaker#1 没有能力 game.input',
    });
    const granted = s.safety.grant('speaker#1', 'stage.audio');
    assert.ok(granted.ok);
    assert.equal(granted.lease.token, 1);
  } finally {
    await s.close();
  }
});

test('每个资源至多一个持有者；过期后他人可以取得，令牌递增', async () => {
  const s = await setup();
  try {
    s.safety.requestMode('M1');
    const first = s.safety.grant('speaker#1', 'stage.audio');
    assert.ok(first.ok);
    assert.deepEqual(s.safety.grant('other#2', 'stage.audio'), {
      ok: false,
      reason: '资源 stage.audio 已由 speaker#1 持有',
    });
    s.clock.advance(2000);
    assert.equal(s.safety.leases.isValid('stage.audio', first.lease.token), false);
    const second = s.safety.grant('other#2', 'stage.audio');
    assert.ok(second.ok);
    assert.equal(second.lease.token, first.lease.token + 1);
  } finally {
    await s.close();
  }
});

test('续约延长到期时刻但不改令牌；失效的许可不能续约', async () => {
  const s = await setup();
  try {
    s.safety.requestMode('M1');
    const granted = s.safety.grant('speaker#1', 'stage.audio');
    assert.ok(granted.ok);
    s.clock.advance(1500);
    const renewed = s.safety.renew(granted.lease);
    assert.ok(renewed.ok);
    assert.equal(renewed.lease.token, granted.lease.token);
    s.clock.advance(1500);
    assert.equal(s.safety.leases.isValid('stage.audio', granted.lease.token), true);
    s.clock.advance(500);
    assert.equal(s.safety.renew(renewed.lease).ok, false);
  } finally {
    await s.close();
  }
});

test('吊销后设备拒绝旧令牌；插件停用时内核钩子吊销其全部许可', async () => {
  const s = await setup();
  try {
    s.safety.requestMode('M1');
    const updates: Array<number | undefined> = [];
    s.safety.leases.subscribe((u) => updates.push(u.lease?.token));
    const granted = s.safety.grant('speaker#1', 'stage.audio');
    assert.ok(granted.ok);
    s.safety.kernelHooks().revokeLeases('speaker#1');
    assert.equal(s.safety.leases.isValid('stage.audio', granted.lease.token), false);
    assert.deepEqual(updates, [1, undefined]);
    // 吊销同样递增令牌，重新授予的令牌大于吊销前。
    assert.equal(s.store.token('stage.audio'), 2);
    const again = s.safety.grant('speaker#1', 'stage.audio');
    assert.ok(again.ok);
    assert.equal(again.lease.token, 3);
  } finally {
    await s.close();
  }
});
