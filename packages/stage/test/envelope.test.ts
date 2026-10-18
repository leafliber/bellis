import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ClockService,
  catalog,
  definePlugin,
  Kernel,
  ManualClock,
  type ResolvedEntry,
  TraceService,
} from '@bellis/kernel';
import { SafetyCore, SafetyService, safetyFacade } from '@bellis/safety';
import { StateStore } from '@bellis/store';
import Type from 'typebox';
import {
  EnvelopeBuilder,
  type PlaybackResult,
  STAGE_AUDIO,
  type Stage,
  StageService,
  simStagePage,
  stageService,
} from '../src/index.ts';

const constant = (n: number, value: number) => new Int16Array(n).fill(value);

test('响度包络：窗口按原始采样率折算，跨块累计，结束时补算不满一窗的余量', () => {
  assert.equal(new EnvelopeBuilder(24_000, 20).window, 480);
  assert.equal(new EnvelopeBuilder(22_050, 20).window, 441);

  const envelope = new EnvelopeBuilder(16_000, 20);
  assert.equal(envelope.window, 320);
  // 640 个满幅一半的采样分成不整齐的几块送入：恰好两个窗口。
  for (const size of [100, 300, 240]) envelope.push(constant(size, 16_384));
  assert.deepEqual(envelope.rms, [0.5, 0.5]);
  // ±8192 交替的方波 RMS 为满幅的 1/4；余下的 160 个采样在结束时成为最后一个窗口。
  envelope.push(Int16Array.from({ length: 320 }, (_, i) => (i % 2 === 0 ? 8192 : -8192)));
  envelope.push(constant(160, 0));
  assert.deepEqual(envelope.rms, [0.5, 0.5, 0.25]);
  envelope.finish();
  assert.deepEqual(envelope.rms, [0.5, 0.5, 0.25, 0]);
  // 没有余量时结束不再多出窗口。
  envelope.finish();
  assert.equal(envelope.rms.length, 4);
});

function entry(id: string, plugin: string, grant: string[] = [], config = {}): ResolvedEntry {
  return { id, plugin, config, disabled: false, explicitSwitch: false, grant };
}

/** 模拟页面 + Stage 服务 + 代表发声仲裁的播放方，全部由手动时钟驱动。 */
async function setup() {
  const clock = new ManualClock();
  const store = StateStore.open({ path: ':memory:' });
  store.recover();
  let kernel: Kernel | undefined;
  const core = new SafetyCore({
    store,
    clock,
    config: {
      simulation: true,
      leaseTtlMs: { [STAGE_AUDIO]: 10_000 },
      leaseCapabilities: { [STAGE_AUDIO]: 'speech.output' },
      presenceTtlMs: 60_000,
      rateLimits: {},
      guardTimeoutMs: 200,
      emergency: { stageSource: 'Stage', safeScene: 'Safe', stopStream: false },
      unattendedGatesSatisfied: false,
    },
    obs: { ready: true, run: async () => ({ ok: true, results: [] }) },
    permissionsOf: (holder) => kernel?.permissionsOf(holder),
    watchdogConnected: () => true,
  });
  kernel = new Kernel({ clock, safety: core.kernelHooks() });
  kernel.provideCore(ClockService, clock);
  /** 模拟页面的追踪（字幕的每次写出与回报），带上时刻。 */
  const traces: Array<{ at: number; kind: string; data: Record<string, unknown> }> = [];
  kernel.provideCore(TraceService, {
    record: (kind, data) => traces.push({ at: clock.now(), kind, data }),
  });
  kernel.provideScoped(SafetyService, ({ instanceId }) => safetyFacade(core, instanceId));

  let stage: Stage | undefined;
  let grant: (() => number) | undefined;
  const speaker = definePlugin({
    manifest: {
      id: 'test-speaker',
      version: '1.0.0',
      tier: 'ordinary',
      provides: [],
      inject: [SafetyService.ref, StageService.ref],
      permissions: [],
      process: 'in-process',
      config: Type.Object({}),
    },
    activate(ctx) {
      const safety = ctx.service(SafetyService);
      stage = ctx.service(StageService);
      grant = () => {
        const granted = safety.grant(STAGE_AUDIO);
        if (!granted.ok) throw new Error(granted.reason);
        return granted.lease.token;
      };
    },
  });
  kernel.add(
    [
      entry('stage-page', 'stage-page-sim'),
      entry('stage', 'stage-service'),
      entry('speaker', 'test-speaker', ['speech.output']),
    ],
    catalog(simStagePage, stageService, speaker),
  );
  await kernel.settled();
  const mode = core.requestMode('M0');
  assert.ok(mode.ok);
  const active = kernel;
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return {
    stage: () => stage as Stage,
    traces,
    token: () => (grant as () => number)(),
    flush,
    async run(ms: number) {
      for (let elapsed = 0; elapsed < ms; elapsed += 10) {
        clock.advance(10);
        await flush();
      }
    },
    async close() {
      await active.shutdown();
      store.close();
    },
  };
}

/** 由测试逐块放行的音频流。 */
function feed() {
  const chunks: Int16Array[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  async function* audio() {
    for (;;) {
      const chunk = chunks.shift();
      if (chunk) {
        yield chunk;
        continue;
      }
      if (done) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  return {
    audio: audio(),
    push(chunk: Int16Array) {
      chunks.push(chunk);
      wake?.();
    },
    end() {
      done = true;
      wake?.();
    },
  };
}

test('Stage 服务：转发音频时按句累计包络；播完或截断后不再提供', async () => {
  const s = await setup();
  try {
    const stage = s.stage();
    const first = feed();
    const played = stage.play(
      { id: 'a', subtitle: '你好', sampleRate: 16_000 },
      first.audio,
      s.token(),
    );
    await s.flush();
    assert.deepEqual(stage.envelope('a')?.rms, []);
    first.push(constant(480, 16_384));
    await s.flush();
    const envelope = stage.envelope('a');
    assert.equal(envelope?.sampleRate, 16_000);
    assert.equal(envelope?.window, 320);
    assert.deepEqual(envelope?.rms, [0.5]);
    first.push(constant(100, 8192));
    first.end();
    await s.flush();
    // 第二个窗口跨两块：160 个满幅一半；结束时补算的余量还有 100 个满幅四分之一。
    const rms = stage.envelope('a')?.rms ?? [];
    assert.equal(rms.length, 2);
    assert.equal(rms[0], 0.5);
    assert.ok(Math.abs((rms[1] ?? 0) - Math.sqrt((160 * 0.25 + 100 * 0.0625) / 260)) < 1e-9);
    await s.run(100);
    const result: PlaybackResult = await played;
    assert.equal(result.complete, true);
    assert.equal(stage.envelope('a'), undefined);

    const second = feed();
    const truncated = stage.play(
      { id: 'b', subtitle: '再见', sampleRate: 16_000 },
      second.audio,
      s.token(),
    );
    second.push(constant(16_000, 1000));
    await s.run(40);
    assert.ok(stage.envelope('b'));
    stage.truncate('b');
    await s.run(20);
    assert.equal((await truncated).complete, false);
    assert.equal(stage.envelope('b'), undefined);
    assert.equal(stage.envelope('不存在'), undefined);
  } finally {
    await s.close();
  }
});

test('呈现延迟：模拟页面的字幕按它推迟，播完后的清除也推迟；截断立即清除', async () => {
  const s = await setup();
  try {
    const stage = s.stage();
    stage.setPresentation({ delayMs: 100, samples: 0, source: 'initial' });
    const first = feed();
    const played = stage.play(
      { id: 'a', subtitle: '你好', sampleRate: 16_000, subtitleStarts: () => [0, 1600] },
      first.audio,
      s.token(),
    );
    first.push(constant(3200, 1000));
    first.end();
    await s.run(600);
    assert.equal((await played).complete, true);
    const at = (kind: string, id: string) =>
      s.traces.find((t) => t.kind === kind && t.data.sentenceId === id)?.at ?? Number.NaN;
    const writes = (id: string, from: number) =>
      s.traces
        .filter(
          (t) => t.kind === 'page.subtitle' && (t.data.sentenceId === id || t.data.text === ''),
        )
        .filter((t) => t.at >= from)
        .map((t) => [t.at - from, t.data.text, t.data.hidden]);
    const started = at('page.started', 'a');
    // 模拟页面每 20ms 一拍、每拍 320 个采样：第 5 拍播到采样 1600，第 10 拍播完。
    assert.deepEqual(writes('a', started), [
      [100, '你', '好'],
      [180, '你好', ''],
      [280, '', ''],
    ]);
    assert.equal(at('page.ended', 'a') - started, 180);

    const second = feed();
    const truncated = stage.play(
      { id: 'b', subtitle: '再见', sampleRate: 16_000 },
      second.audio,
      s.token(),
    );
    second.push(constant(16_000, 1000));
    await s.run(300);
    stage.truncate('b');
    await s.run(20);
    assert.equal((await truncated).complete, false);
    const cut = at('page.truncated', 'b');
    assert.deepEqual(writes('b', at('page.started', 'b')).at(-1)?.slice(1), ['', '']);
    assert.equal(s.traces.filter((t) => t.kind === 'page.subtitle').at(-1)?.at, cut);
  } finally {
    await s.close();
  }
});
