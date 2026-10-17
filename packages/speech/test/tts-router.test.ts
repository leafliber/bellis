import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  catalog,
  definePlugin,
  Kernel,
  type ResolvedEntry,
  type ServiceToken,
  systemClock,
} from '@bellis/kernel';
import { SafetyCore, SafetyService, safetyFacade } from '@bellis/safety';
import { StateStore } from '@bellis/store';
import Type from 'typebox';
import {
  CloudTtsService,
  LocalTtsService,
  type Synthesis,
  type Tts,
  type TtsEngine,
  type TtsOption,
  TtsRequestError,
  type TtsRouting,
  TtsRoutingService,
  TtsService,
  ttsRouter,
} from '../src/index.ts';

/** 可控的假引擎：`ready`、`status` 与每次合成的行为都由测试改变。 */
interface FakeEngine {
  ready: boolean;
  status: string;
  /** 设置后下一次合成抛出它。 */
  error: Error | undefined;
  calls: number;
}

function fakeEngine(id: string, token: ServiceToken<TtsEngine>, state: FakeEngine) {
  return definePlugin({
    manifest: {
      id,
      version: '1.0.0',
      tier: 'ordinary',
      provides: [token.ref],
      inject: [],
      permissions: [],
      process: 'in-process',
      config: Type.Object({}),
    },
    activate(ctx) {
      ctx.provide(token, {
        get ready() {
          return state.ready;
        },
        get status() {
          return state.status;
        },
        async synthesize(spoken): Promise<Synthesis> {
          state.calls += 1;
          if (state.error) throw state.error;
          const samples = [...spoken].length * 10;
          return {
            sampleRate: 8000,
            totalSamples: samples,
            timing: undefined,
            frames: (async function* () {
              yield new Int16Array(samples);
            })(),
          };
        },
      });
    },
  });
}

function entry(id: string, plugin: string, config: unknown = {}): ResolvedEntry {
  return { id, plugin, config, disabled: false, explicitSwitch: false, grant: [] };
}

async function world(order: TtsOption[]) {
  const store = StateStore.open({ path: ':memory:' });
  store.recover();
  const clock = systemClock();
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  let kernel: Kernel | undefined;
  const safety = new SafetyCore({
    store,
    clock,
    config: {
      simulation: true,
      leaseTtlMs: {},
      leaseCapabilities: {},
      presenceTtlMs: 60_000,
      rateLimits: {},
      guardTimeoutMs: 200,
      emergency: { stageSource: 'Stage', safeScene: 'Safe', stopStream: false },
      unattendedGatesSatisfied: false,
    },
    obs: { ready: false, run: async () => ({ ok: false, results: [] }) },
    permissionsOf: (holder) => kernel?.permissionsOf(holder),
    watchdogConnected: () => false,
  });
  const host = new Kernel({
    clock,
    safety: safety.kernelHooks(),
    log: (event, fields) => logs.push({ event, fields }),
  });
  kernel = host;
  host.provideScoped(SafetyService, ({ instanceId }) => safetyFacade(safety, instanceId));
  const local: FakeEngine = { ready: true, status: '就绪', error: undefined, calls: 0 };
  const cloud: FakeEngine = { ready: true, status: '可用：minimax', error: undefined, calls: 0 };
  const consumer = definePlugin({
    manifest: {
      id: 'consumer',
      version: '1.0.0',
      tier: 'ordinary',
      provides: [],
      inject: [TtsService.ref],
      permissions: [],
      process: 'in-process',
      config: Type.Object({}),
    },
    activate() {},
  });
  host.add(
    [
      entry('local', 'fake-local'),
      entry('cloud', 'fake-cloud'),
      entry('tts', 'tts-router', { order }),
      entry('consumer', 'consumer'),
    ],
    catalog(
      fakeEngine('fake-local', LocalTtsService, local),
      fakeEngine('fake-cloud', CloudTtsService, cloud),
      ttsRouter,
      consumer,
    ),
  );
  await host.settled();
  const service = <T>(token: ServiceToken<T>): T => {
    const found = host.services.resolve(token.name, token.major);
    if ('missing' in found) throw new Error(found.missing);
    return found.impl as T;
  };
  return {
    kernel: host,
    local,
    cloud,
    logs,
    tts: () => service<Tts>(TtsService),
    routing: () => service<TtsRouting>(TtsRoutingService),
    state: (id: string) => host.snapshot().find((e) => e.id === id)?.state,
    switched: () =>
      store
        .events()
        .filter((e) => e.type === 'tts.switched')
        .map((e) => e.data),
    async close() {
      await host.shutdown();
      store.close();
    },
  };
}

const signal = () => new AbortController().signal;

async function drain(synthesis: Synthesis): Promise<number> {
  let samples = 0;
  for await (const frame of synthesis.frames) samples += frame.length;
  return samples;
}

test('按顺序选第一个就绪的引擎；未就绪或失败时改用下一个，恢复后换回，每次换用记事件并提示操作员', async () => {
  const w = await world(['local', 'cloud', 'subtitles']);
  try {
    assert.equal(await drain(await w.tts().synthesize('你好', signal())), 20);
    assert.equal(w.local.calls, 1);
    assert.deepEqual(w.switched(), []);

    w.local.ready = false;
    w.local.status = '模型加载中';
    await drain(await w.tts().synthesize('你好', signal()));
    assert.equal(w.cloud.calls, 1);

    w.cloud.error = new Error('minimax 鉴权失败');
    const subtitles = await w.tts().synthesize('你好', signal());
    assert.equal(subtitles.sampleRate, 16_000);

    w.local.ready = true;
    await drain(await w.tts().synthesize('你好', signal()));
    assert.deepEqual(w.switched(), [
      { from: 'local', to: 'cloud', reason: 'local 模型加载中' },
      { from: 'cloud', to: 'subtitles', reason: 'local 模型加载中；cloud minimax 鉴权失败' },
      { from: 'subtitles', to: 'local', reason: 'local 恢复可用' },
    ]);
    const hints = w.logs.filter((l) => l.event === 'tts.switched').map((l) => l.fields.hint);
    assert.deepEqual(hints, [
      '已改用 cloud，音色会变化，请操作员留意',
      '已改为只出字幕，请操作员留意',
      '已改用 local，音色会变化，请操作员留意',
    ]);
  } finally {
    await w.close();
  }
});

test('引擎以文本本身为由拒绝的句子不换引擎，这一句失败', async () => {
  const w = await world(['cloud', 'local', 'subtitles']);
  try {
    w.cloud.error = new TtsRequestError('文本过长');
    await assert.rejects(w.tts().synthesize('你好', signal()), /文本过长/);
    assert.equal(w.local.calls, 0);
    assert.deepEqual(w.switched(), []);
  } finally {
    await w.close();
  }
});

test('只出字幕：静音帧按估计时长铺开，映射完整', async () => {
  const w = await world(['subtitles']);
  try {
    const synthesis = await w.tts().synthesize('你好，世界。', signal());
    const samples = await drain(synthesis);
    // 220ms/字，句末标点 1.5 倍，16kHz。
    assert.equal(synthesis.sampleRate, 16_000);
    assert.equal(samples, Math.round(6.5 * 220 * 16));
    assert.equal(synthesis.totalSamples, samples);
    assert.equal(synthesis.timing?.length, 6);
    assert.equal(w.routing().primary(), undefined);
  } finally {
    await w.close();
  }
});

test('引擎不在时 tts@1 仍在、依赖方照常运行；没有任何可用引擎时合成以错误结束', async () => {
  const w = await world(['local', 'cloud']);
  try {
    await w.kernel.disable('local');
    await w.kernel.disable('cloud');
    assert.equal(w.state('tts'), 'active');
    assert.equal(w.state('consumer'), 'active');
    await assert.rejects(
      w.tts().synthesize('你好', signal()),
      /没有可用的 TTS 引擎：local 不在；cloud 不在/,
    );
    assert.deepEqual(w.switched(), [{ from: 'local', to: null, reason: 'local 不在；cloud 不在' }]);
    assert.deepEqual(w.routing().primary(), { engine: 'local', ready: false, status: '不在' });
    await w.kernel.enable('local');
    assert.deepEqual(w.routing().primary(), { engine: 'local', ready: true, status: '就绪' });
  } finally {
    await w.close();
  }
});

test('中止后立即返回空的合成，不再尝试引擎', async () => {
  const w = await world(['local', 'subtitles']);
  try {
    const abort = new AbortController();
    abort.abort();
    assert.equal(await drain(await w.tts().synthesize('你好', abort.signal)), 0);
    assert.equal(w.local.calls, 0);
  } finally {
    await w.close();
  }
});
