import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './helpers.ts';

test('启动时处于安全停止；sim 下只能进入 M0，非 sim 不能进入 M0', async () => {
  const real = await setup();
  const sim = await setup({ simulation: true });
  try {
    assert.equal(real.safety.mode, 'safe-stop');
    assert.deepEqual(real.safety.requestMode('M0'), {
      ok: false,
      reason: 'M0 只在 sim profile 下可用',
    });
    assert.deepEqual(sim.safety.requestMode('M1'), {
      ok: false,
      reason: 'sim profile 下只允许 M0',
    });
    assert.deepEqual(sim.safety.requestMode('M0'), { ok: true });
    assert.equal(sim.safety.mode, 'M0');
  } finally {
    await real.close();
    await sim.close();
  }
});

test('升级要重新检查前置条件：看门狗、在场确认', async () => {
  const s = await setup();
  try {
    s.world.watchdog = false;
    assert.deepEqual(s.safety.requestMode('M1'), { ok: false, reason: '外部看门狗未连接' });
    s.world.watchdog = true;
    assert.deepEqual(s.safety.requestMode('M2'), { ok: false, reason: '在场确认无效' });
    s.safety.confirmPresence();
    assert.deepEqual(s.safety.requestMode('M2'), { ok: true });
    assert.equal(s.events('supervision.refused').length, 2);
  } finally {
    await s.close();
  }
});

test('审核插件关闭时无法进入 M3；M3 中关闭审核会自动降级', async () => {
  const s = await setup();
  try {
    s.safety.setModeration(false);
    assert.deepEqual(s.safety.requestMode('M3'), {
      ok: false,
      reason: '审核插件未启用，不允许进入无人值守',
    });
    s.safety.setModeration(true);
    s.safety.confirmPresence();
    assert.deepEqual(s.safety.requestMode('M3'), { ok: true });
    s.safety.setModeration(false);
    assert.equal(s.safety.mode, 'M1');
    assert.deepEqual(
      s.events('moderation.switched').map((e) => (e.data as { enabled: boolean }).enabled),
      [false, true, false],
    );
  } finally {
    await s.close();
  }
});

test('审核未显式设置时也不允许进入 M3', async () => {
  const s = await setup();
  try {
    assert.equal(s.safety.moderationEnabled, undefined);
    assert.equal(s.safety.requestMode('M3').ok, false);
  } finally {
    await s.close();
  }
});

test('无人值守门槛未满足时不允许进入 M3', async () => {
  const s = await setup({ unattendedGatesSatisfied: false });
  try {
    s.safety.setModeration(true);
    assert.deepEqual(s.safety.requestMode('M3'), { ok: false, reason: '无人值守门槛尚未满足' });
  } finally {
    await s.close();
  }
});

test('在场确认过期：M2 自动进入安全停止并切安全场景', async () => {
  const s = await setup({ presenceTtlMs: 1000 });
  try {
    s.safety.confirmPresence();
    s.safety.requestMode('M2');
    s.clock.advance(999);
    assert.equal(s.safety.mode, 'M2');
    s.clock.advance(1);
    assert.equal(s.safety.mode, 'safe-stop');
    for (let i = 0; i < 50 && s.obs.currentScene !== 'Safe'; i += 1)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(s.obs.currentScene, 'Safe');
    assert.equal(s.obs.muted.get('Stage'), true);
  } finally {
    await s.close();
  }
});

test('自动降级：在场确认有效时 M2 降到 M1，M1 再降进入安全停止', async () => {
  const s = await setup();
  try {
    s.safety.confirmPresence();
    s.safety.requestMode('M2');
    assert.equal(s.safety.downgrade('测试'), 'M1');
    assert.equal(s.safety.downgrade('测试'), 'safe-stop');
    assert.equal(s.safety.mode, 'safe-stop');
  } finally {
    await s.close();
  }
});

test('维护态只能从安全停止进入，期间不能进入输出模式', async () => {
  const s = await setup();
  try {
    s.safety.requestMode('M1');
    assert.equal(s.safety.enterMaintenance().ok, false);
    s.safety.requestMode('safe-stop');
    assert.equal(s.safety.enterMaintenance().ok, true);
    assert.equal(s.safety.kernelHooks().inMaintenance(), true);
    assert.deepEqual(s.safety.requestMode('M1'), { ok: false, reason: '维护态中不能进入输出模式' });
    s.safety.exitMaintenance();
    assert.equal(s.safety.requestMode('M1').ok, true);
  } finally {
    await s.close();
  }
});
