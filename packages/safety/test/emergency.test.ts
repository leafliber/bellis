import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ControlSignal } from '../src/index.ts';
import { request, setup } from './helpers.ts';

test('急停：吊销全部许可、广播停止、静音并切安全场景，此后没有新的输出', async () => {
  const s = await setup();
  try {
    s.safety.requestMode('M1');
    const signals: ControlSignal[] = [];
    s.safety.control.subscribe((signal) => signals.push(signal));
    const granted = s.safety.grant('speaker#1', 'stage.audio');
    assert.ok(granted.ok);

    const report = await s.safety.emergencyStop('操作员急停');
    assert.deepEqual(report, { reason: '操作员急停', revoked: 1, obs: { ok: true } });
    assert.equal(s.safety.leases.isValid('stage.audio', granted.lease.token), false);
    assert.deepEqual(signals[0], { kind: 'stop', reason: '操作员急停' });
    assert.equal(s.safety.mode, 'safe-stop');
    assert.equal(s.obs.muted.get('Stage'), true);
    assert.equal(s.obs.currentScene, 'Safe');

    assert.equal(s.safety.grant('speaker#1', 'stage.audio').ok, false);
    assert.equal(s.safety.renew(granted.lease).ok, false);
    assert.equal((await s.safety.authorize(request())).allowed, false);
  } finally {
    await s.close();
  }
});

test('状态存储不可用时急停照常执行', async () => {
  let broken = false;
  const s = await setup(
    {},
    {
      fault: (point) => {
        if (broken && point.endsWith('before-commit')) {
          throw Object.assign(new Error('disk I/O error'), {
            code: 'ERR_SQLITE_ERROR',
            errcode: 10,
          });
        }
      },
    },
  );
  try {
    s.safety.requestMode('M1');
    const granted = s.safety.grant('speaker#1', 'stage.audio');
    assert.ok(granted.ok);
    broken = true;
    const report = await s.safety.emergencyStop('存储坏了');
    assert.equal(report.obs.ok, true);
    assert.equal(s.safety.leases.isValid('stage.audio', granted.lease.token), false);
    assert.equal(s.safety.mode, 'safe-stop');
    assert.equal(s.obs.currentScene, 'Safe');
  } finally {
    await s.close();
  }
});

test('OBS 不可用时急停仍吊销许可并进入安全停止，结果报告失败并告警', async () => {
  const s = await setup();
  try {
    s.safety.requestMode('M1');
    s.obs.failing = true;
    const report = await s.safety.emergencyStop('测试');
    assert.equal(report.obs.ok, false);
    assert.equal(s.safety.mode, 'safe-stop');
    assert.ok(s.logs.some((l) => l.event === 'safety.alarm'));
  } finally {
    await s.close();
  }
});

test('关键平面收尾超时走急停；普通插件只记录 unknown', async () => {
  const s = await setup();
  try {
    s.safety.requestMode('M1');
    const hooks = s.safety.kernelHooks();
    hooks.quiesceTimedOut({
      entryId: 'avatar',
      instanceId: 'avatar#1',
      tier: 'ordinary',
      process: 'in-process',
      error: 'x',
    });
    assert.equal(s.safety.mode, 'M1');
    hooks.quiesceTimedOut({
      entryId: 'arbiter',
      instanceId: 'arbiter#2',
      tier: 'critical',
      process: 'in-process',
      error: 'x',
    });
    assert.equal(s.safety.mode, 'safe-stop');
    assert.deepEqual(
      s.events('plugin.quiesce-timed-out').map((e) => (e.data as { outcome: string }).outcome),
      ['unknown', 'unknown'],
    );
  } finally {
    await s.close();
  }
});

test('关键平面在输出模式下意外停用时走急停', async () => {
  const s = await setup();
  try {
    s.safety.requestMode('M1');
    s.safety.onPluginTransition(
      { entryId: 'tts', from: 'active', to: 'quiescing', reason: 'x' },
      'ordinary',
    );
    assert.equal(s.safety.mode, 'M1');
    s.safety.onPluginTransition(
      { entryId: 'stage', from: 'active', to: 'quiescing', reason: '断开' },
      'critical',
    );
    assert.equal(s.safety.mode, 'safe-stop');
  } finally {
    await s.close();
  }
});

test('看门狗报告已执行应急动作：输出模式下走急停进入安全停止，并记录事实', async () => {
  const s = await setup();
  try {
    s.safety.requestMode('M1');
    const granted = s.safety.grant('speaker#1', 'stage.audio');
    assert.ok(granted.ok);
    s.obs.currentScene = 'Live';
    s.safety.watchdogActed({
      reason: 'heartbeat-lost',
      ok: true,
      actedAt: new Date().toISOString(),
    });
    assert.equal(s.safety.mode, 'safe-stop');
    assert.equal(s.safety.leases.isValid('stage.audio', granted.lease.token), false);
    assert.equal(s.events('watchdog.acted').length, 1);
    await s.safety.emergencyStop('等待前一次急停完成');
    assert.equal(s.obs.currentScene, 'Safe');
  } finally {
    await s.close();
  }
});

test('看门狗报告：已在安全停止时只记录；看门狗动作失败时用自己的应急连接再做一次', async () => {
  const s = await setup();
  try {
    s.obs.currentScene = 'Live';
    s.safety.watchdogActed({
      reason: 'connection-lost',
      ok: true,
      actedAt: new Date().toISOString(),
    });
    assert.equal(s.events('watchdog.acted').length, 1);
    assert.equal(s.events('safety.emergency-requested').length, 0);
    assert.equal(s.obs.currentScene, 'Live');

    s.safety.watchdogActed({
      reason: 'connection-lost',
      ok: false,
      actedAt: new Date().toISOString(),
    });
    assert.equal(s.events('safety.emergency-requested').length, 1);
    await s.safety.emergencyStop('等待前一次急停完成');
    assert.equal(s.obs.currentScene, 'Safe');
  } finally {
    await s.close();
  }
});
