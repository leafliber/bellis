import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LlmError } from '@bellis/director';
import { type EntrySnapshot, ManualClock } from '@bellis/kernel';
import { IrisError } from '@bellis/memory';
import type { SidecarQos } from '@bellis/protocol';
import { SafetyCore } from '@bellis/safety';
import { StateStore } from '@bellis/store';
import { type PreflightInputs, preflight } from '../src/preflight.ts';
import { danmakuReport, llmReport } from '../src/readiness.ts';

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
  unresolved: [],
  plugins: [plugin('stage', 'active'), plugin('moderation', 'waiting', false)],
  stageReady: true,
  avatar: { ready: true, status: '就绪' },
  moderationEnabled: false,
  reviewPresent: true,
  ttsPrimary: { engine: 'local', ready: true, status: '就绪' },
  danmaku: undefined,
  llm: undefined,
  memory: undefined,
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

test('开播预检：本地 TTS 作主引擎时，sidecar 须处于 HighQoS；非 Windows 不核对', async () => {
  const withQos = (engine: string, qos: () => Promise<SidecarQos>) =>
    preflight({ ...ready, ttsPrimary: { engine, ready: true, status: '就绪', qos } });
  const read = (qos: SidecarQos) => async () => qos;
  assert.deepEqual(await withQos('local', read('high')), []);
  assert.deepEqual(await withQos('local', read('unsupported')), []);
  assert.deepEqual(await withQos('local', read('eco')), [
    '本地 TTS 的 sidecar 被系统节流（EcoQoS），推理会变慢，先关掉效率模式',
  ]);
  assert.deepEqual(await withQos('local', read('default')), [
    '本地 TTS 的 sidecar 没有声明 HighQoS（节流由系统管理），推理可能变慢',
  ]);
  assert.deepEqual(await withQos('local', read('unknown')), ['读不到本地 TTS sidecar 的节流状态']);
  const failing = async (): Promise<SidecarQos> => {
    throw new Error('RPC 超时');
  };
  assert.deepEqual(await withQos('local', failing), [
    '读不到本地 TTS sidecar 的节流状态：RPC 超时',
  ]);
  // 只核对作主引擎的本地 TTS。
  assert.deepEqual(await withQos('cloud', read('eco')), []);
});

test('开播预检：本地引擎未就绪时两项都报告', async () => {
  const failures = await preflight({
    ...ready,
    ttsPrimary: { engine: 'local', ready: false, status: '模型加载中', qos: async () => 'eco' },
  });
  assert.deepEqual(failures, [
    'TTS 主引擎 local 未就绪：模型加载中',
    '本地 TTS 的 sidecar 被系统节流（EcoQoS），推理会变慢，先关掉效率模式',
  ]);
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
      preflight({ ...ready, target, safetyBlocker: core.preconditionBlocker(target), ...extra });
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

    // 已在 M2 中跑 M2 的预检：不报“已经处于该模式”；看门狗断开照样报出。
    assert.deepEqual(core.requestMode('M2'), { ok: true });
    assert.deepEqual(await check('M2'), []);
    watchdog.connected = false;
    assert.deepEqual(await check('M2'), ['外部看门狗未连接']);
  } finally {
    close();
  }
});

const NOW = Date.parse('2026-10-21T08:00:00Z');

test('开播预检：弹幕接入不就绪时列出状态说明与缺口已持续多久，就绪时不列；没有启用弹幕接入时不核对', async () => {
  const waiting = danmakuReport(
    {
      subscribe: () => () => {},
      ready: false,
      status:
        '等待重试（约 50 秒后）：开启场次失败，直播间已有场次或上一场没有正常结束：平台返回错误 7002',
      gap: () => ({ reason: '开启场次失败（7002）', startedAt: NOW - 75_000 }),
    },
    NOW,
  );
  assert.deepEqual(waiting.gap, {
    reason: '开启场次失败（7002）',
    startedAt: new Date(NOW - 75_000).toISOString(),
    durationMs: 75_000,
  });
  assert.deepEqual(await preflight({ ...ready, danmaku: waiting }), [
    '弹幕接入未就绪：等待重试（约 50 秒后）：开启场次失败，直播间已有场次或上一场没有正常结束：平台返回错误 7002；缺口已持续 1 分 15 秒',
  ]);
  const receiving = danmakuReport(
    { subscribe: () => () => {}, ready: true, status: '接收中（a.chat.bilibili.com）' },
    NOW,
  );
  assert.deepEqual(await preflight({ ...ready, danmaku: receiving }), []);
  // 启用了却不在场（例如激活失败）：同样未通过。
  assert.deepEqual(await preflight({ ...ready, danmaku: danmakuReport(undefined, NOW) }), [
    '弹幕接入未就绪：不在场',
  ]);
  // 不报告就绪状态的来源按未就绪核对。
  assert.deepEqual(
    await preflight({ ...ready, danmaku: danmakuReport({ subscribe: () => () => {} }, NOW) }),
    ['弹幕接入未就绪：没有就绪报告'],
  );
  assert.deepEqual(await preflight({ ...ready, danmaku: undefined }), []);
});

test('开播预检：决策插件启用而 llm@1 缺失或未就绪时列出（带最近一次失败的类别，不带服务端的说明）', async () => {
  assert.deepEqual(await preflight({ ...ready, llm: llmReport(undefined) }), [
    '决策模型未就绪：llm@1 不在场',
  ]);
  const unready = llmReport({
    complete: async () => '',
    ready: false,
    status: '鉴权失败（auth，HTTP 401），下一次成功之前不就绪',
    failures: { consecutive: 1, last: { kind: 'auth', at: NOW, status: 401 } },
  });
  assert.deepEqual(unready.lastFailure, { kind: 'auth', at: new Date(NOW).toISOString() });
  assert.equal(unready.consecutiveFailures, 1);
  assert.deepEqual(await preflight({ ...ready, llm: unready }), [
    '决策模型未就绪：鉴权失败（auth，HTTP 401），下一次成功之前不就绪',
  ]);
  const fine = llmReport({ complete: async () => '', ready: true, status: '就绪' });
  assert.deepEqual(await preflight({ ...ready, llm: fine }), []);
  // 不报告就绪状态的客户端按未就绪核对。
  assert.deepEqual(await preflight({ ...ready, llm: llmReport({ complete: async () => '' }) }), [
    '决策模型未就绪：没有就绪报告',
  ]);
});

test('开播预检：模型客户端配置了探测时以探测的结果为准，失败只列类别、HTTP 状态与错误码；没有探测时不发请求', async () => {
  let probes = 0;
  const notReady = llmReport({
    complete: async () => '',
    ready: false,
    status: '连续失败 3 次（最近一次：timeout）',
  });
  // 探测成功：之前的连续失败不再算（客户端在探测成功时清零）。
  const passing = {
    ...notReady,
    probe: async () => {
      probes += 1;
    },
  };
  assert.deepEqual(await preflight({ ...ready, llm: passing }), []);
  assert.equal(probes, 1);
  const failing = {
    ...llmReport({ complete: async () => '', ready: true, status: '就绪' }),
    probe: async () => {
      probes += 1;
      throw new LlmError('auth', '鉴权失败：HTTP 401（AuthenticationError）：服务端的说明', {
        status: 401,
        code: 'AuthenticationError',
      });
    },
  };
  assert.deepEqual(await preflight({ ...ready, llm: failing }), [
    '决策模型的探测请求失败（auth，HTTP 401，AuthenticationError）',
  ]);
  assert.equal(probes, 2);
  // 没有配置探测：只按就绪报告判定，不发请求。
  assert.deepEqual(await preflight({ ...ready, llm: notReady }), [
    '决策模型未就绪：连续失败 3 次（最近一次：timeout）',
  ]);
  assert.equal(probes, 2);
});

test('开播预检：启用了记忆时 memory@1 须在场，且能以宿主令牌访问 Iris；失败只列类别、HTTP 状态与错误码', async () => {
  let checks = 0;
  const reachable = {
    check: async () => {
      checks += 1;
    },
  };
  assert.deepEqual(await preflight({ ...ready, memory: reachable }), []);
  assert.equal(checks, 1, '每次预检访问一次 Iris 的 GET /status');
  // Iris 客户端没有激活（例如外发配置未确认、令牌没录入）：memory@1 不在场。
  assert.deepEqual(await preflight({ ...ready, memory: {} }), [
    '记忆未就绪：memory@1 不在场（Iris 客户端或记忆插件没有激活，原因见插件状态）',
  ]);
  const denied = {
    check: async () => {
      throw new IrisError('auth', '鉴权失败：HTTP 401（invalid_token）', {
        status: 401,
        code: 'invalid_token',
      });
    },
  };
  assert.deepEqual(await preflight({ ...ready, memory: denied }), [
    'Iris 不能以宿主令牌访问（auth，HTTP 401，invalid_token）',
  ]);
  const starting = {
    check: async () => {
      throw new Error('Iris 的服务状态为 starting');
    },
  };
  assert.deepEqual(await preflight({ ...ready, memory: starting }), [
    'Iris 不能以宿主令牌访问：Iris 的服务状态为 starting',
  ]);
  // 没有启用记忆：不核对、不访问 Iris。
  assert.deepEqual(await preflight({ ...ready, memory: undefined }), []);
  assert.equal(checks, 1);
});

test('开播预检：有结果未知的意图时按目标列出意图编号与结案方法；结案之后通过', async () => {
  const unresolved = [
    { id: 7, target: 'iris:bellis:drill' },
    { id: 9, target: 'obs:Stage' },
    { id: 12, target: 'iris:bellis:drill' },
  ];
  assert.deepEqual(await preflight({ ...ready, unresolved }), [
    '目标 iris:bellis:drill 有结果未知的意图（编号 7、12），已隔离：核对外部状态后用 pnpm operator resolve <编号> <succeeded|failed> 结案',
    '目标 obs:Stage 有结果未知的意图（编号 9），已隔离：核对外部状态后用 pnpm operator resolve <编号> <succeeded|failed> 结案',
  ]);
  assert.deepEqual(await preflight({ ...ready, unresolved: [] }), []);
});
