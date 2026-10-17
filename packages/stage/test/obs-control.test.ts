import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catalog, definePlugin, Kernel, type ResolvedEntry, systemClock } from '@bellis/kernel';
import { ObsClient, SimObs } from '@bellis/obs';
import { type Decision, SafetyCore, SafetyService, STAGE_URL, safetyFacade } from '@bellis/safety';
import { type Intent, StateStore } from '@bellis/store';
import Type from 'typebox';
import {
  OBS_CONTROL,
  type ObsAction,
  ObsConnectorService,
  ObsControlService,
  obsControl,
} from '../src/index.ts';

interface Caller {
  authorize(action: ObsAction, capabilities: string[], untrusted?: boolean): Promise<Decision>;
  run(intent: Intent, action: ObsAction): Promise<Intent>;
}

function entry(id: string, plugin: string, grant: string[]): ResolvedEntry {
  return { id, plugin, config: {}, disabled: false, explicitSwitch: false, grant };
}

async function setup() {
  const path = join(tmpdir(), `bellis-obs-control-${randomBytes(6).toString('hex')}.db`);
  const store = StateStore.open({ path });
  const clock = systemClock();
  const obs = await SimObs.start({ scenes: ['Live', 'Safe', 'Game'], inputs: ['Stage'] });
  let kernel: Kernel | undefined;
  const core = new SafetyCore({
    store,
    clock,
    config: {
      simulation: false,
      leaseTtlMs: { [OBS_CONTROL]: 2000, [STAGE_URL]: 2000 },
      leaseCapabilities: { [OBS_CONTROL]: 'obs.control', [STAGE_URL]: 'obs.control' },
      presenceTtlMs: 60_000,
      rateLimits: {},
      guardTimeoutMs: 200,
      emergency: { stageSource: 'Stage', safeScene: 'Safe', stopStream: false },
      unattendedGatesSatisfied: false,
    },
    // 急停走安全核自己的应急连接，这里不关心它的效果。
    obs: { ready: true, run: async () => ({ ok: true, results: [] }) },
    permissionsOf: (holder) => kernel?.permissionsOf(holder),
    watchdogConnected: () => true,
  });
  kernel = new Kernel({ clock, safety: core.kernelHooks(), quiesceTimeoutMs: 500 });
  kernel.provideScoped(SafetyService, ({ instanceId }) => safetyFacade(core, instanceId));
  kernel.provideCore(ObsConnectorService, { connect: () => ObsClient.connect(obs.url, undefined) });

  // 代表需要 OBS 动作的插件：自己申请授权，再交给 OBS 控制执行。
  let caller: Caller | undefined;
  let next = 0;
  const callerPlugin = definePlugin({
    manifest: {
      id: 'obs-caller',
      version: '1.0.0',
      tier: 'ordinary',
      provides: [],
      inject: [SafetyService.ref, ObsControlService.ref],
      permissions: [],
      process: 'in-process',
      config: Type.Object({}),
    },
    activate(ctx) {
      const safety = ctx.service(SafetyService);
      const control = ctx.service(ObsControlService);
      caller = {
        authorize: (action, capabilities, untrusted = false) => {
          next += 1;
          return safety.authorize({
            key: `obs-${next}`,
            type: `obs.${action.kind}`,
            target: 'obs',
            payload: action,
            source: { origin: 'test', inputs: [], untrusted },
            capabilities,
            timeSensitive: true,
          });
        },
        run: (intent, action) => control.run(intent, action),
      };
    },
  });
  kernel.add(
    [
      entry('obs', 'obs-control', ['obs.control']),
      entry('caller', 'obs-caller', ['obs.scene', 'obs.audio', 'obs.source', STAGE_URL]),
    ],
    catalog(obsControl, callerPlugin),
  );
  await kernel.settled();
  const active = kernel;
  return {
    core,
    obs,
    store,
    caller: () => {
      if (!caller) throw new Error('调用方插件未激活');
      return caller;
    },
    async authorized(action: ObsAction, capabilities: string[]): Promise<Intent> {
      const decision = await this.caller().authorize(action, capabilities);
      assert.ok(decision.allowed, decision.allowed ? '' : decision.reason);
      return decision.intent;
    },
    async close() {
      await active.shutdown();
      store.close();
      await obs.close();
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    },
  };
}

test('输出模式下执行已授权的切场景、静音与写来源设置，每次都取得并交还 OBS 控制许可', async () => {
  const s = await setup();
  try {
    assert.ok(s.core.requestMode('M1').ok);
    const scene: ObsAction = { kind: 'scene', sceneName: 'Game' };
    const done = await s.caller().run(await s.authorized(scene, ['obs.scene']), scene);
    assert.equal(done.state, 'succeeded');
    assert.equal(s.obs.currentScene, 'Game');

    const mute: ObsAction = { kind: 'mute', inputName: 'Stage', muted: true };
    assert.equal(
      (await s.caller().run(await s.authorized(mute, ['obs.audio']), mute)).state,
      'succeeded',
    );
    assert.equal(s.obs.muted.get('Stage'), true);

    const settings: ObsAction = {
      kind: 'input-settings',
      inputName: 'Stage',
      inputSettings: { url: 'http://127.0.0.1:1/#t' },
    };
    const written = await s.caller().run(await s.authorized(settings, ['obs.source']), settings);
    assert.equal(written.state, 'succeeded');
    assert.equal(s.obs.inputSettings.get('Stage')?.url, 'http://127.0.0.1:1/#t');

    const grants = s.store.events().filter((e) => e.type === 'lease.granted');
    assert.equal(grants.length, 3);
    // 每次执行完都已交还：最后一次授予的令牌已失效。
    const last = (grants[grants.length - 1]?.data as { token: number } | undefined)?.token ?? 0;
    assert.equal(s.core.leases.isValid(OBS_CONTROL, last), false);
  } finally {
    await s.close();
  }
});

test('授权后进入安全停止：拿不到许可，意图失败，OBS 不动', async () => {
  const s = await setup();
  try {
    assert.ok(s.core.requestMode('M1').ok);
    const scene: ObsAction = { kind: 'scene', sceneName: 'Game' };
    const intent = await s.authorized(scene, ['obs.scene']);
    await s.core.emergencyStop('测试');
    const result = await s.caller().run(intent, scene);
    assert.equal(result.state, 'failed');
    assert.match(result.error ?? '', /拿不到 OBS 控制许可/);
    assert.equal(s.obs.currentScene, 'Live');
  } finally {
    await s.close();
  }
});

test('意图没有申请动作所需的能力、或载荷被替换时不执行', async () => {
  const s = await setup();
  try {
    assert.ok(s.core.requestMode('M1').ok);
    const scene: ObsAction = { kind: 'scene', sceneName: 'Game' };
    const wrong = await s.caller().run(await s.authorized(scene, ['obs.audio']), scene);
    assert.equal(wrong.state, 'failed');
    assert.match(wrong.error ?? '', /没有申请 obs\.scene/);

    const intent = await s.authorized(scene, ['obs.scene']);
    await assert.rejects(
      s.caller().run(intent, { kind: 'scene', sceneName: 'Safe' }),
      /载荷与授权时不一致/,
    );
    assert.equal(s.obs.currentScene, 'Live');
    assert.equal(s.obs.requests.length, 0);
  } finally {
    await s.close();
  }
});

test('含不可信输入的意图不能申请任何 OBS 管理能力', async () => {
  const s = await setup();
  try {
    assert.ok(s.core.requestMode('M1').ok);
    for (const [action, capability] of [
      [{ kind: 'scene', sceneName: 'Game' }, 'obs.scene'],
      [{ kind: 'mute', inputName: 'Stage', muted: false }, 'obs.audio'],
      [{ kind: 'input-settings', inputName: 'Stage', inputSettings: {} }, 'obs.source'],
    ] as const) {
      const decision = await s.caller().authorize(action, [capability], true);
      assert.equal(decision.allowed, false);
    }
  } finally {
    await s.close();
  }
});

test('安全停止下只能写 Stage URL：只写急停静音的那个 Stage 源，其它动作与混合申请都被拒', async () => {
  const s = await setup();
  try {
    assert.equal(s.core.mode, 'safe-stop');
    const url: ObsAction = { kind: 'stage-url', url: 'http://127.0.0.1:2/#token' };
    const written = await s.caller().run(await s.authorized(url, [STAGE_URL]), url);
    assert.equal(written.state, 'succeeded');
    assert.equal(s.obs.inputSettings.get('Stage')?.url, 'http://127.0.0.1:2/#token');

    const scene: ObsAction = { kind: 'scene', sceneName: 'Game' };
    assert.equal((await s.caller().authorize(scene, ['obs.scene'])).allowed, false);
    assert.equal((await s.caller().authorize(url, [STAGE_URL, 'obs.scene'])).allowed, false);
    assert.equal((await s.caller().authorize(url, [STAGE_URL], true)).allowed, false);

    // 维护态中同样拒绝。
    assert.ok(s.core.enterMaintenance().ok);
    assert.equal((await s.caller().authorize(url, [STAGE_URL])).allowed, false);
    assert.equal(s.obs.currentScene, 'Live');
  } finally {
    await s.close();
  }
});
