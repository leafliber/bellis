import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventSubscription, ObsClient } from '@bellis/obs';
import { type ControlSignal, EMERGENCY_EVENTS, OBS_EXTERNAL_REASON } from '../src/index.ts';
import { setup } from './helpers.ts';

/** 等条件满足（OBS 事件经网络到达）；超时即失败。 */
async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('条件未在时限内满足');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type Setup = Awaited<ReturnType<typeof setup>>;

const completed = (s: Setup) => s.events('safety.emergency-completed');
const external = (s: Setup) => s.events('safety.obs-external').map((e) => e.data);
const ignored = (s: Setup) => s.logs.filter((l) => l.event === 'safety.obs-external-ignored');
const requested = (s: Setup) =>
  s.events('safety.emergency-requested').map((e) => (e.data as { reason: string }).reason);

test('应急连接订阅场景与输入两类事件', async () => {
  const s = await setup();
  try {
    assert.equal(EMERGENCY_EVENTS, EventSubscription.Scenes | EventSubscription.Inputs);
    assert.equal(EMERGENCY_EVENTS, (1 << 2) | (1 << 3));
    assert.deepEqual(s.obs.subscriptions, [EMERGENCY_EVENTS]);
  } finally {
    await s.close();
  }
});

test('真实输出模式下 OBS 外部切到安全场景：记事实后走完整的急停路径，静音也再做一遍', async () => {
  const s = await setup();
  try {
    assert.ok(s.safety.requestMode('M1').ok);
    const granted = s.safety.grant('speaker#1', 'stage.audio');
    assert.ok(granted.ok);
    const signals: ControlSignal[] = [];
    s.safety.control.subscribe((signal) => signals.push(signal));
    const before = s.obs.requests.length;

    // 像在 OBS 里按了“切到安全场景”的热键：只切场景，没有静音。
    s.obs.setProgramScene('Safe');
    await until(() => completed(s).length === 1);

    assert.equal(s.safety.mode, 'safe-stop');
    assert.equal(s.safety.leases.isValid('stage.audio', granted.lease.token), false);
    assert.deepEqual(external(s), [{ change: 'scene', scene: 'Safe', resync: false, mode: 'M1' }]);
    assert.deepEqual(requested(s), [OBS_EXTERNAL_REASON.scene]);
    assert.equal(OBS_EXTERNAL_REASON.scene, 'OBS 外部切到安全场景');
    assert.deepEqual(signals[0], { kind: 'stop', reason: 'OBS 外部切到安全场景' });
    assert.deepEqual(signals.at(-1), {
      kind: 'emergency-completed',
      reason: 'OBS 外部切到安全场景',
      obsOk: true,
    });
    // 应急动作再做了一遍：Stage 源也静音了。
    assert.deepEqual(
      s.obs.requests.slice(before).map((r) => r.requestType),
      ['SetInputMute', 'SetCurrentProgramScene'],
    );
    assert.equal(s.obs.muted.get('Stage'), true);
    assert.equal(s.obs.currentScene, 'Safe');
    // 应急动作自己引起的静音事件只写日志，不重复急停。
    await until(() => ignored(s).some((l) => l.fields.change === 'mute'));
    assert.equal(completed(s).length, 1);
  } finally {
    await s.close();
  }
});

test('真实输出模式下 OBS 外部静音了 Stage 源：走完整的急停路径，切场景也再做一遍', async () => {
  const s = await setup();
  try {
    s.safety.confirmPresence();
    assert.ok(s.safety.requestMode('M2').ok);
    s.obs.setInputMuted('Stage', true);
    await until(() => completed(s).length === 1);
    assert.equal(s.safety.mode, 'safe-stop');
    assert.deepEqual(external(s), [{ change: 'mute', input: 'Stage', resync: false, mode: 'M2' }]);
    assert.deepEqual(requested(s), ['OBS 外部静音了 Stage 源']);
    assert.equal(s.obs.currentScene, 'Safe');
    assert.ok(s.logs.some((l) => l.event === 'safety.alarm' && l.fields.reason === 'obs-external'));
  } finally {
    await s.close();
  }
});

test('别的场景、别的输入、取消静音都不触发急停', async () => {
  const s = await setup();
  try {
    assert.ok(s.safety.requestMode('M1').ok);
    s.obs.emitEvent('CurrentProgramSceneChanged', EventSubscription.Scenes, { sceneName: 'Live' });
    s.obs.emitEvent('CurrentProgramSceneChanged', EventSubscription.Scenes, {
      sceneName: 'Safe2',
    });
    s.obs.emitEvent('InputMuteStateChanged', EventSubscription.Inputs, {
      inputName: 'Mic',
      inputMuted: true,
    });
    s.obs.emitEvent('InputMuteStateChanged', EventSubscription.Inputs, {
      inputName: 'Stage',
      inputMuted: false,
    });
    // 字段不全或类型不对的事件忽略。
    s.obs.emitEvent('InputMuteStateChanged', EventSubscription.Inputs, { inputName: 'Stage' });
    s.obs.emitEvent('CurrentProgramSceneChanged', EventSubscription.Scenes, {});
    // 同一条连接上的事件按顺序到达：等最后这一条触发急停时，前面的都已处理过。
    s.obs.setInputMuted('Stage', true);
    await until(() => completed(s).length === 1);
    assert.deepEqual(external(s), [{ change: 'mute', input: 'Stage', resync: false, mode: 'M1' }]);
    assert.deepEqual(requested(s), [OBS_EXTERNAL_REASON.mute]);
  } finally {
    await s.close();
  }
});

test('安全停止、M0 与维护态下 OBS 外部变化只写日志', async () => {
  // 启动后处于安全停止。
  const s = await setup();
  try {
    s.obs.setProgramScene('Safe');
    await until(() => ignored(s).length === 1);
    assert.deepEqual(ignored(s)[0]?.fields, {
      change: 'scene',
      scene: 'Safe',
      resync: false,
      mode: 'safe-stop',
      maintenance: false,
    });
    // 维护态。
    assert.ok(s.safety.enterMaintenance().ok);
    s.obs.setInputMuted('Stage', true);
    await until(() => ignored(s).length === 2);
    assert.equal(ignored(s)[1]?.fields.maintenance, true);
    assert.deepEqual(external(s), []);
    assert.deepEqual(requested(s), []);
  } finally {
    await s.close();
  }

  const sim = await setup({ simulation: true });
  try {
    assert.ok(sim.safety.requestMode('M0').ok);
    sim.obs.setInputMuted('Stage', true);
    await until(() => ignored(sim).length === 1);
    assert.equal(ignored(sim)[0]?.fields.mode, 'M0');
    assert.equal(sim.safety.mode, 'M0');
    assert.deepEqual(requested(sim), []);
  } finally {
    await sim.close();
  }
});

test('安全核自己急停引起的场景与静音事件不重复急停', async () => {
  const s = await setup();
  try {
    assert.ok(s.safety.requestMode('M1').ok);
    await s.safety.emergencyStop('操作员急停');
    await until(() => ignored(s).length === 2);
    assert.deepEqual(requested(s), ['操作员急停']);
    assert.deepEqual(external(s), []);
  } finally {
    await s.close();
  }
});

test('看门狗先动了手、OBS 事件先于 watchdog.acted 到达：来源记为 OBS 外部变化，之后的报告只记录', async () => {
  const s = await setup();
  const watchdog = await ObsClient.connect(s.obs.url, undefined);
  try {
    assert.ok(s.safety.requestMode('M1').ok);
    // 看门狗的 RequestBatch：静音 Stage 源、切安全场景。
    await watchdog.batch([
      { requestType: 'SetInputMute', requestData: { inputName: 'Stage', inputMuted: true } },
      { requestType: 'SetCurrentProgramScene', requestData: { sceneName: 'Safe' } },
    ]);
    await until(() => completed(s).length === 1);
    assert.deepEqual(requested(s), ['OBS 外部静音了 Stage 源']);
    s.safety.watchdogActed({
      reason: 'heartbeat-lost',
      ok: true,
      actedAt: new Date().toISOString(),
    });
    assert.equal(s.events('watchdog.acted').length, 1);
    assert.deepEqual(requested(s), ['OBS 外部静音了 Stage 源']);
    assert.equal(s.safety.mode, 'safe-stop');
  } finally {
    watchdog.close();
    await s.close();
  }
});

test('应急连接断开重连后，真实输出模式下核对一次当前状态：断开期间已切到安全场景的按急停处理', async () => {
  const s = await setup();
  try {
    assert.ok(s.safety.requestMode('M1').ok);
    // 先断开再恢复，没有变化：只核对，不急停。
    s.obs.disconnectAll();
    await until(() => s.logs.some((l) => l.event === 'safety.obs-disconnected'));
    s.clock.advance(1000);
    await until(() => s.logs.some((l) => l.event === 'safety.obs-resynced'));
    assert.equal(s.safety.mode, 'M1');
    assert.deepEqual(s.logs.find((l) => l.event === 'safety.obs-resynced')?.fields, {
      sceneName: 'Live',
      stageMuted: false,
    });

    // 断开期间节目场景被切到安全场景（事件收不到）。
    s.obs.disconnectAll();
    await until(() => s.logs.filter((l) => l.event === 'safety.obs-disconnected').length === 2);
    s.obs.currentScene = 'Safe';
    s.clock.advance(1000);
    await until(() => completed(s).length === 1);
    assert.equal(s.safety.mode, 'safe-stop');
    assert.deepEqual(external(s), [{ change: 'scene', scene: 'Safe', resync: true, mode: 'M1' }]);
    assert.deepEqual(requested(s), [OBS_EXTERNAL_REASON.scene]);
    assert.equal(s.obs.muted.get('Stage'), true);
  } finally {
    await s.close();
  }
});

test('安全停止中重连不核对；断开期间被静音、重连后在输出模式下也按急停处理', async () => {
  const s = await setup();
  try {
    s.obs.disconnectAll();
    await until(() => s.logs.some((l) => l.event === 'safety.obs-disconnected'));
    s.clock.advance(1000);
    await until(() => s.logs.filter((l) => l.event === 'safety.obs-connected').length === 2);
    assert.equal(
      s.logs.some((l) => l.event === 'safety.obs-resynced'),
      false,
    );

    assert.ok(s.safety.requestMode('M1').ok);
    s.obs.disconnectAll();
    await until(() => s.logs.filter((l) => l.event === 'safety.obs-disconnected').length === 2);
    s.obs.muted.set('Stage', true);
    s.clock.advance(1000);
    await until(() => completed(s).length === 1);
    assert.deepEqual(external(s), [{ change: 'mute', input: 'Stage', resync: true, mode: 'M1' }]);
  } finally {
    await s.close();
  }
});
