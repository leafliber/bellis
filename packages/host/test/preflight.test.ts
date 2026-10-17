import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type EntrySnapshot, ManualClock } from '@bellis/kernel';
import { SafetyCore } from '@bellis/safety';
import { StateStore } from '@bellis/store';
import { type PreflightInputs, preflight } from '../src/preflight.ts';

const plugin = (id: string, state: EntrySnapshot['state'], enabled = true): EntrySnapshot => ({
  id,
  plugin: id,
  version: '0.1.0',
  tier: 'ordinary',
  process: 'in-process',
  state,
  reason: state === 'active' ? undefined : '缺少服务 tts@1',
  instanceId: undefined,
  enabled,
});

const ready: PreflightInputs = {
  target: 'M1',
  safetyBlocker: undefined,
  plugins: [plugin('stage', 'active'), plugin('moderation', 'waiting', false)],
  stageReady: true,
  avatar: { ready: true, status: '就绪' },
  moderationEnabled: false,
  reviewPresent: true,
  ttsPrimary: { engine: 'local', ready: true, status: '就绪' },
  inspectObs: async () => [],
};

test('开播预检：全部就绪时没有未通过项', async () => {
  assert.deepEqual(await preflight(ready), []);
});

test('开播预检：形象在场但未就绪时列出状态；profile 不含形象时不作要求', async () => {
  assert.deepEqual(
    await preflight({
      ...ready,
      avatar: { ready: false, status: '参数 MouthOpen 已被其他插件占用' },
    }),
    ['形象未就绪（参数 MouthOpen 已被其他插件占用）'],
  );
  assert.deepEqual(await preflight({ ...ready, avatar: undefined }), []);
});

test('开播预检：插件未就绪、Stage 未认证、审核开关未设置、M1 缺放行环节、OBS 目标不对都列出', async () => {
  const failures = await preflight({
    ...ready,
    plugins: [plugin('tts', 'waiting'), plugin('off', 'waiting', false)],
    stageReady: false,
    moderationEnabled: undefined,
    reviewPresent: false,
    ttsPrimary: { engine: 'local', ready: false, status: '模型加载中' },
    inspectObs: async () => ['OBS 中没有安全场景「Safe」'],
  });
  assert.deepEqual(failures, [
    '插件 tts 未就绪（waiting：缺少服务 tts@1）',
    'Stage 页面尚未认证',
    '审核插件的开关没有在 profile 中显式设置',
    'TTS 主引擎 local 未就绪：模型加载中',
    'M1 需要逐句放行环节（speech-review）',
    'OBS 中没有安全场景「Safe」',
  ]);
});

test('开播预检：M2 不要求放行环节；没有 Stage 服务或 OBS 核对出错都算未通过', async () => {
  const failures = await preflight({
    ...ready,
    target: 'M2',
    reviewPresent: false,
    stageReady: undefined,
    inspectObs: async () => {
      throw new Error('连接已关闭');
    },
  });
  assert.deepEqual(failures, ['Stage 服务不在场', 'OBS 预检失败：连接已关闭']);
});

test('开播预检：没有 TTS 路由（只用模拟 TTS）时不核对 TTS 主引擎', async () => {
  assert.deepEqual(await preflight({ ...ready, ttsPrimary: undefined }), []);
});

/** 真实的安全核：只在内存里，OBS 应急连接视为可用，看门狗是否连接由调用方决定。 */
function safetyCore(watchdog: { connected: boolean }) {
  const store = StateStore.open({ path: ':memory:' });
  const core = new SafetyCore({
    store,
    clock: new ManualClock(),
    config: {
      simulation: false,
      leaseTtlMs: {},
      leaseCapabilities: {},
      presenceTtlMs: 60_000,
      rateLimits: {},
      guardTimeoutMs: 200,
      emergency: { stageSource: 'Stage', safeScene: 'Safe', stopStream: false },
      unattendedGatesSatisfied: false,
    },
    obs: { ready: true, run: async () => ({ ok: true, results: [] }) },
    permissionsOf: () => undefined,
    watchdogConnected: () => watchdog.connected,
  });
  return { core, close: () => store.close() };
}

test('开播预检：先列出安全核的拒绝原因——看门狗未连接、M2 的在场确认无效', async () => {
  const watchdog = { connected: false };
  const { core, close } = safetyCore(watchdog);
  try {
    const check = (target: 'M1' | 'M2', extra: Partial<PreflightInputs> = {}) =>
      preflight({ ...ready, target, safetyBlocker: core.modeBlocker(target), ...extra });
    assert.deepEqual(await check('M1'), ['外部看门狗未连接']);
    assert.deepEqual(await check('M2'), ['外部看门狗未连接']);
    // 安全核的原因在前，其余各项照常列出。
    assert.deepEqual(await check('M1', { stageReady: false }), [
      '外部看门狗未连接',
      'Stage 页面尚未认证',
    ]);

    watchdog.connected = true;
    assert.deepEqual(await check('M1'), [], 'M1 不要求在场确认');
    assert.deepEqual(await check('M2'), ['在场确认无效']);

    core.confirmPresence();
    assert.deepEqual(await check('M1'), []);
    assert.deepEqual(await check('M2'), []);
  } finally {
    close();
  }
});
