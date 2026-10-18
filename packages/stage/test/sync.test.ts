import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClockService, catalog, Kernel, ManualClock, type ResolvedEntry } from '@bellis/kernel';
import { INPUT_VOLUME_METERS, type MeterLevel, ObsMeters, SimObs } from '@bellis/obs';
import { type SafetyFacade, SafetyService } from '@bellis/safety';
import {
  DelayEstimator,
  type Envelope,
  type FromPage,
  OBS_METERS,
  ObsMetersService,
  type PlaybackResult,
  type Presentation,
  type Stage,
  StageService,
  StageSync,
  type StageSyncOptions,
  stageSync,
} from '../src/index.ts';

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('估计：样本不够用初值；够了取中位数减 k_sub；窗口滑动，离群值不影响', () => {
  const e = new DelayEstimator({
    initialMs: 82,
    kSubMs: 4,
    window: 5,
    minSamples: 3,
    hysteresisMs: 5,
  });
  assert.deepEqual([e.delayMs, e.samples, e.estimated, e.medianMs], [82, 0, false, undefined]);
  assert.equal(e.add(90), false);
  assert.equal(e.add(100), false);
  assert.equal(e.delayMs, 82, '两句还不够');
  assert.equal(e.add(95), true);
  assert.deepEqual([e.medianMs, e.delayMs, e.estimated], [95, 91, true]);
  // 偶数个样本取中间两个的平均：(93 + 95) / 2 - 4 = 90，与 91 只差 1，不更新。
  assert.equal(e.add(93), false);
  assert.deepEqual([e.medianMs, e.delayMs], [94, 91]);
  // 窗口只留最近 5 句。
  for (let i = 0; i < 5; i++) e.add(120);
  assert.deepEqual([e.samples, e.medianMs, e.delayMs], [5, 120, 116]);
  assert.equal(e.add(600), false);
  assert.equal(e.add(0), false);
  assert.equal(e.delayMs, 116, '两个离群值进了窗口，中位数不变');
});

test('估计：迟滞——与当前值相差不超过 5ms 不更新，超过才更新', () => {
  const e = new DelayEstimator({
    initialMs: 82,
    kSubMs: 0,
    window: 1,
    minSamples: 1,
    hysteresisMs: 5,
  });
  assert.equal(e.add(87), false);
  assert.equal(e.delayMs, 82);
  assert.equal(e.add(88), true);
  assert.equal(e.delayMs, 88);
  assert.equal(e.add(83), false);
  assert.equal(e.add(93), false);
  assert.equal(e.delayMs, 88);
  assert.equal(e.add(82), true);
  assert.equal(e.delayMs, 82);
});

test('估计：取整并限制在 0–300ms', () => {
  const e = new DelayEstimator({
    initialMs: 82,
    kSubMs: 4,
    window: 1,
    minSamples: 1,
    hysteresisMs: 5,
  });
  e.add(400);
  assert.equal(e.delayMs, 300);
  e.add(2);
  assert.equal(e.delayMs, 0);
  e.add(100.6);
  assert.equal(e.delayMs, 97);
});

test('估计：加上 Stage 源的同步偏移，负的同步偏移按 0 计', () => {
  const e = new DelayEstimator({
    initialMs: 82,
    kSubMs: 4,
    window: 5,
    minSamples: 3,
    hysteresisMs: 5,
  });
  assert.equal(e.setSyncOffset(20), true);
  assert.equal(e.delayMs, 102, '初值也加同步偏移');
  assert.equal(e.setSyncOffset(-80), true);
  assert.equal(e.delayMs, 82);
  for (const sample of [100, 100, 100]) e.add(sample);
  assert.equal(e.delayMs, 96);
  assert.equal(e.setSyncOffset(50), true);
  assert.equal(e.delayMs, 146);
  assert.equal(e.syncOffsetMs, 50);
});

/** 测试用 Stage：直接注入页面回报与包络，记下写进来的呈现延迟。 */
class FakeStage implements Stage {
  readonly ready = true;
  readonly envelopes = new Map<string, Envelope>();
  presentation: Presentation = { delayMs: 0, samples: 0, source: 'none' };
  readonly presentations: Presentation[] = [];
  readonly #listeners = new Set<(event: FromPage) => void>();

  async play(): Promise<PlaybackResult> {
    throw new Error('测试用 Stage 不播放');
  }

  truncate(): void {}

  onEvent(listener: (event: FromPage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  envelope(sentenceId: string): Envelope | undefined {
    return this.envelopes.get(sentenceId);
  }

  setPresentation(presentation: Presentation): void {
    this.presentation = presentation;
    this.presentations.push(presentation);
  }

  emit(event: FromPage): void {
    for (const listener of [...this.#listeners]) listener(event);
  }
}

/** 测试用音量表连接：读数由测试发出，记下读同步偏移的次数。 */
class FakeMeters {
  connected = true;
  syncOffset: number | null = 0;
  syncOffsetReads = 0;
  readonly #levels = new Set<(levels: MeterLevel[]) => void>();
  readonly #close = new Set<(reason: string) => void>();

  onLevels(listener: (levels: MeterLevel[]) => void): () => void {
    this.#levels.add(listener);
    return () => this.#levels.delete(listener);
  }

  onClose(listener: (reason: string) => void): () => void {
    this.#close.add(listener);
    return () => this.#close.delete(listener);
  }

  async audioSyncOffset(): Promise<number | null> {
    this.syncOffsetReads += 1;
    return this.syncOffset;
  }

  /** Stage 源此刻的峰值。 */
  level(peakDb: number): void {
    for (const listener of [...this.#levels]) listener([{ inputName: 'Stage', peakDb }]);
  }

  close(reason = '已关闭'): void {
    if (!this.connected) return;
    this.connected = false;
    for (const listener of [...this.#close]) listener(reason);
  }
}

const OPTIONS: StageSyncOptions = {
  initialMs: 82,
  kSubMs: 4,
  window: 21,
  minSamples: 5,
  hysteresisMs: 5,
  syncOffsetPollMs: 10_000,
  reconnectMs: 5000,
};

const QUIET = -60;
const LOUD = -14;

async function setup(options: { connect?: () => Promise<ObsMeters> } = {}) {
  const clock = new ManualClock();
  const stage = new FakeStage();
  const meters: FakeMeters[] = [];
  const logs: Array<{ at: number; event: string; fields: Record<string, unknown> }> = [];
  const sync = new StageSync({
    stage,
    clock,
    connector: {
      connect:
        options.connect ??
        (async () => {
          const next = new FakeMeters();
          meters.push(next);
          return next as unknown as ObsMeters;
        }),
    },
    stageSource: 'Stage',
    options: OPTIONS,
    log: (event, fields = {}) => logs.push({ at: clock.now(), event, fields }),
  });
  sync.start();
  await flush();
  const current = () => meters.at(-1) as FakeMeters;
  return {
    clock,
    stage,
    sync,
    meters: current,
    logs,
    events: (name: string) => logs.filter((l) => l.event === name).map((l) => l.fields),
    /**
     * 一句：包络的起音在 onsetMs，开始播放时页面上已经静了很久；音量表每 50ms 一次读数，
     * 在开始后 onsetMs + delayMs 第一次过门限，1 秒后播完。
     */
    async sentence(id: string, delayMs: number, onsetMs = 0) {
      stage.envelopes.set(id, {
        sampleRate: 24_000,
        window: 480,
        rms: [],
        onset: onsetMs * 24,
        audibleEnd: 24_000,
      });
      const startedAt = clock.now();
      stage.emit({ kind: 'started', sentenceId: id });
      const rise = startedAt + onsetMs + delayMs;
      for (let t = startedAt + 10; t < rise; t += 50) {
        clock.advance(t - clock.now());
        current().level(QUIET);
      }
      clock.advance(rise - clock.now());
      current().level(LOUD);
      clock.advance(startedAt + 1000 - clock.now());
      current().level(LOUD);
      stage.emit({ kind: 'ended', sentenceId: id, played: 24_000 });
      clock.advance(450);
      current().level(QUIET);
      clock.advance(550);
      await flush();
    },
  };
}

test('每句的样本：音量表第一次过门限的时刻减去开始播放与包络起音；够 5 句后按中位数减 k_sub', async () => {
  const s = await setup();
  try {
    assert.deepEqual(s.stage.presentation, { delayMs: 82, samples: 0, source: 'initial' });
    const delays = [86, 92, 88, 90, 95];
    for (const [k, delay] of delays.entries()) await s.sentence(`s${k}`, delay, k === 1 ? 120 : 0);
    assert.deepEqual(
      s.events('stage-sync.sample').map((f) => f.sampleMs),
      [86, 92, 88, 90, 95],
      '第二句的起音晚 120ms，样本照样是音量表的时延',
    );
    // 前 4 句还是初值；第 5 句后中位数 90 - 4 = 86，与 82 差 4，不超过迟滞量。
    assert.deepEqual(s.stage.presentation, { delayMs: 82, samples: 5, source: 'meters' });
    await s.sentence('s5', 100);
    await s.sentence('s6', 100);
    // 中位数 92 - 4 = 88：变化 6ms，更新并记日志。
    assert.deepEqual(s.stage.presentation, { delayMs: 88, samples: 7, source: 'meters' });
    const delay = s.events('stage-sync.delay').at(-1);
    assert.deepEqual(
      [delay?.delayMs, delay?.previousMs, delay?.medianMs, delay?.samples],
      [88, 82, 92, 7],
    );
  } finally {
    s.sync.stop();
  }
});

test('不取样本：起音前静音太短、连上时已在门限以上、超时没看到、出声前被截断、没有出声的音频', async () => {
  const s = await setup();
  try {
    const envelope = (onset: number | undefined): Envelope => ({
      sampleRate: 24_000,
      window: 480,
      rms: [],
      onset,
      audibleEnd: onset === undefined ? undefined : 24_000,
    });
    // 刚连上：上一次读数按“在门限以上”算，一直响着的读数不是上升沿；500ms 后放弃。
    s.stage.envelopes.set('a', envelope(0));
    s.stage.emit({ kind: 'started', sentenceId: 'a' });
    for (let t = 0; t < 600; t += 50) {
      s.clock.advance(50);
      s.meters().level(LOUD);
    }
    s.stage.emit({ kind: 'ended', sentenceId: 'a', played: 24_000 });
    // 紧接着下一句：上一句的余音可能还在 OBS 里。
    s.clock.advance(20);
    s.stage.envelopes.set('b', envelope(0));
    s.stage.emit({ kind: 'started', sentenceId: 'b' });
    s.clock.advance(1000);
    s.meters().level(QUIET);
    s.stage.emit({ kind: 'ended', sentenceId: 'b', played: 24_000 });
    s.clock.advance(2000);
    // 出声前被截断。
    s.stage.envelopes.set('c', envelope(2400));
    s.stage.emit({ kind: 'started', sentenceId: 'c' });
    s.clock.advance(50);
    s.stage.emit({ kind: 'truncated', sentenceId: 'c', played: 1200, reason: '要求截断' });
    s.clock.advance(2000);
    // 开始播放时还没有出声的音频。
    s.stage.envelopes.set('d', envelope(undefined));
    s.stage.emit({ kind: 'started', sentenceId: 'd' });
    assert.deepEqual(
      s.events('stage-sync.sample').map((f) => [f.sentenceId, f.sampleMs, f.reason]),
      [
        ['a', null, '音量表 500ms 内没有看到出声'],
        ['b', null, '起音前的静音太短'],
        ['c', null, '出声前被截断'],
        ['d', null, '开始播放时还没有出声的音频'],
      ],
    );
    assert.deepEqual(s.stage.presentation, { delayMs: 82, samples: 0, source: 'initial' });
  } finally {
    s.sync.stop();
  }
});

test('起音之前的上升沿是上一句的余音，不算这一句的样本', async () => {
  const s = await setup();
  try {
    s.stage.envelopes.set('a', {
      sampleRate: 24_000,
      window: 480,
      rms: [],
      onset: 2400,
      audibleEnd: 24_000,
    });
    s.stage.emit({ kind: 'started', sentenceId: 'a' });
    s.clock.advance(10);
    s.meters().level(QUIET);
    s.clock.advance(40);
    s.meters().level(LOUD);
    s.clock.advance(50);
    s.meters().level(QUIET);
    s.clock.advance(85);
    s.meters().level(LOUD);
    assert.deepEqual(
      s.events('stage-sync.sample').map((f) => f.sampleMs),
      [85],
    );
  } finally {
    s.sync.stop();
  }
});

test('降级：音量表连不上时用初值、只记一次日志；断开后沿用断开前的值，重连后恢复估计', async () => {
  let fail = true;
  const fakes: FakeMeters[] = [];
  const s = await setup({
    connect: async () => {
      if (fail) throw new Error('无法连接 OBS');
      const next = new FakeMeters();
      fakes.push(next);
      return next as unknown as ObsMeters;
    },
  });
  try {
    assert.deepEqual(s.stage.presentation, { delayMs: 82, samples: 0, source: 'initial' });
    for (let i = 0; i < 3; i++) {
      s.clock.advance(OPTIONS.reconnectMs);
      await flush();
    }
    assert.equal(s.events('stage-sync.meters-unavailable').length, 1, '同样的原因只记一次');
    fail = false;
    s.clock.advance(OPTIONS.reconnectMs);
    await flush();
    assert.equal(s.events('stage-sync.meters-connected').length, 1);
    const meters = fakes[0] as FakeMeters;
    // 借用 setup 的 sentence：它从 setup 自己的连接列表取连接，这里换成直接驱动。
    const sentence = async (id: string, delay: number) => {
      s.stage.envelopes.set(id, {
        sampleRate: 24_000,
        window: 480,
        rms: [],
        onset: 0,
        audibleEnd: 24_000,
      });
      s.stage.emit({ kind: 'started', sentenceId: id });
      s.clock.advance(10);
      meters.level(QUIET);
      s.clock.advance(delay - 10);
      meters.level(LOUD);
      s.clock.advance(1000 - delay);
      s.stage.emit({ kind: 'ended', sentenceId: id, played: 24_000 });
      s.clock.advance(500);
      meters.level(QUIET);
      s.clock.advance(500);
      await flush();
    };
    for (let k = 0; k < 5; k++) await sentence(`s${k}`, 120);
    assert.deepEqual(s.stage.presentation, { delayMs: 116, samples: 5, source: 'meters' });

    meters.close('code=1006');
    assert.deepEqual(s.stage.presentation, { delayMs: 116, samples: 5, source: 'held' });
    assert.deepEqual(s.events('stage-sync.meters-lost'), [{ reason: 'code=1006' }]);
    assert.equal(s.events('stage-sync.delay').at(-1)?.source, 'held');
    // 断开期间的句子不取样本，播出照常。
    s.stage.envelopes.set('x', { sampleRate: 24_000, window: 480, rms: [], onset: 0 });
    s.stage.emit({ kind: 'started', sentenceId: 'x' });
    assert.equal(s.events('stage-sync.sample').at(-1)?.reason, '音量表未连接');
    s.stage.emit({ kind: 'ended', sentenceId: 'x', played: 24_000 });
    s.clock.advance(OPTIONS.reconnectMs);
    await flush();
    assert.equal(fakes.length, 2);
    assert.deepEqual(s.stage.presentation, { delayMs: 116, samples: 5, source: 'meters' });
  } finally {
    s.sync.stop();
  }
});

test('同步偏移：定时读 Stage 源的同步偏移并加到呈现延迟上；读不出时沿用上一次的值，只记一次', async () => {
  const s = await setup();
  try {
    const meters = s.meters();
    meters.syncOffset = 20;
    s.clock.advance(OPTIONS.syncOffsetPollMs);
    await flush();
    assert.equal(s.stage.presentation.delayMs, 102);
    assert.deepEqual(s.events('stage-sync.sync-offset'), [{ syncOffsetMs: 20 }]);
    meters.syncOffset = null;
    for (let i = 0; i < 2; i++) {
      s.clock.advance(OPTIONS.syncOffsetPollMs);
      await flush();
    }
    assert.equal(s.stage.presentation.delayMs, 102);
    assert.equal(s.events('stage-sync.sync-offset-unavailable').length, 1);
    meters.syncOffset = 0;
    s.clock.advance(OPTIONS.syncOffsetPollMs);
    await flush();
    assert.equal(s.stage.presentation.delayMs, 82);
    assert.equal(meters.syncOffsetReads, 5);
  } finally {
    s.sync.stop();
  }
});

test('停止后关闭音量表连接，不再重连也不再读同步偏移', async () => {
  const s = await setup();
  const meters = s.meters();
  s.sync.stop();
  assert.equal(meters.connected, false);
  s.clock.advance(60_000);
  await flush();
  assert.equal(meters.syncOffsetReads, 1);
  assert.equal(s.events('stage-sync.meters-connected').length, 1);
});

test('接真实的只读连接（模拟 OBS）：只订阅音量表，除了读同步偏移不发任何请求', async () => {
  const obs = await SimObs.start({ password: 'secret' });
  const clock = new ManualClock();
  const stage = new FakeStage();
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const sync = new StageSync({
    stage,
    clock,
    connector: { connect: () => ObsMeters.connect(obs.url, 'secret') },
    stageSource: 'Stage',
    options: OPTIONS,
    log: (event, fields = {}) => logs.push({ event, fields }),
  });
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('等待超时');
      await new Promise((done) => setTimeout(done, 5));
    }
  };
  try {
    sync.start();
    await until(() => obs.requests.length === 1);
    stage.envelopes.set('a', { sampleRate: 24_000, window: 480, rms: [], onset: 0 });
    stage.emit({ kind: 'started', sentenceId: 'a' });
    const level = (value: number) => [{ inputName: 'Stage', levels: [[value, value, value]] }];
    // 先一次门限以下，再过门限；两条读数按发出的先后到达，都在时钟走过 90ms 之后。
    obs.emitMeters(level(0.001));
    clock.advance(90);
    obs.emitMeters(level(0.2));
    await until(() => logs.some((l) => l.event === 'stage-sync.sample'));
    assert.equal(logs.find((l) => l.event === 'stage-sync.sample')?.fields.sampleMs, 90);
    assert.deepEqual(obs.subscriptions, [INPUT_VOLUME_METERS]);
    assert.deepEqual(
      obs.requests.map((r) => [r.requestType, r.requestData]),
      [['GetInputAudioSyncOffset', { inputName: 'Stage' }]],
    );
  } finally {
    sync.stop();
    await obs.close();
  }
});

function entry(id: string, plugin: string, grant: string[]): ResolvedEntry {
  return { id, plugin, config: {}, disabled: false, explicitSwitch: false, grant };
}

test('插件：没有 obs.meters 不激活；授予后写入初值，停用时呈现延迟回到 0', async () => {
  const run = async (grant: string[]) => {
    const clock = new ManualClock();
    const stage = new FakeStage();
    const connects: string[] = [];
    const kernel = new Kernel({
      clock,
      safety: { revokeLeases: () => {}, quiesceTimedOut: () => {}, inMaintenance: () => false },
    });
    kernel.provideCore(ClockService, clock);
    kernel.provideCore(StageService, stage);
    kernel.provideCore(SafetyService, { stageSource: 'Stage' } as unknown as SafetyFacade);
    // 与宿主相同：只有被授予 obs.meters 的实例能连接。
    kernel.provideScoped(ObsMetersService, ({ instanceId, permissions }) => ({
      connect: () => {
        connects.push(instanceId);
        return permissions.has(OBS_METERS)
          ? Promise.resolve(new FakeMeters() as unknown as ObsMeters)
          : Promise.reject(new Error(`${instanceId} 没有权限 ${OBS_METERS}`));
      },
    }));
    kernel.add([entry('stage-sync', 'stage-sync', grant)], catalog(stageSync));
    await kernel.settled();
    await flush();
    const snapshot = kernel.snapshot().find((e) => e.id === 'stage-sync');
    const presentation = stage.presentation;
    await kernel.shutdown();
    return { snapshot, presentation, after: stage.presentation, connects };
  };
  const denied = await run([]);
  assert.equal(denied.snapshot?.state, 'waiting');
  assert.match(String(denied.snapshot?.reason), /未授予权限 obs\.meters/);
  assert.deepEqual(denied.connects, []);
  const granted = await run([OBS_METERS]);
  assert.equal(granted.snapshot?.state, 'active');
  assert.equal(granted.connects.length, 1);
  assert.deepEqual(granted.presentation, { delayMs: 82, samples: 0, source: 'initial' });
  assert.deepEqual(granted.after, { delayMs: 0, samples: 0, source: 'none' });
});
