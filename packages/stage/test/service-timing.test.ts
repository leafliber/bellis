import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClockService, catalog, definePlugin, Kernel, ManualClock } from '@bellis/kernel';
import {
  type Lease,
  SafetyCore,
  type SafetyFacade,
  SafetyService,
  safetyFacade,
} from '@bellis/safety';
import { StateStore } from '@bellis/store';
import Type from 'typebox';
import {
  type FromPage,
  type PlaybackResult,
  type SentenceInfo,
  STAGE_AUDIO,
  type Stage,
  StagePageService,
  StageService,
  stageService,
  type ToPage,
} from '../src/index.ts';

const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Stage 服务 + 假页面 + 代表发声仲裁的插件。假页面记下收到的消息（心跳与令牌除外），收到 end 即回报播完；
 * 截断由测试回报，模拟页面的往返延迟；像真实页面那样，要求截断之后的 end 不理会。
 */
async function setup() {
  const clock = new ManualClock();
  const store = StateStore.open({ path: ':memory:' });
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  let kernel: Kernel | undefined;
  const core = new SafetyCore({
    store,
    clock,
    config: {
      simulation: false,
      leaseTtlMs: { [STAGE_AUDIO]: 60_000 },
      leaseCapabilities: { [STAGE_AUDIO]: 'speech.output' },
      presenceTtlMs: 600_000,
      rateLimits: {},
      guardTimeoutMs: 200,
      emergency: { stageSource: 'Stage', safeScene: 'Safe', stopStream: false },
      unattendedGatesSatisfied: false,
    },
    obs: { ready: true, run: async () => ({ ok: true, results: [] }) },
    permissionsOf: (holder) => kernel?.permissionsOf(holder),
    watchdogConnected: () => true,
  });
  const sent: ToPage[] = [];
  const listeners = new Set<(message: FromPage) => void>();
  const report = (message: FromPage) => {
    for (const listener of [...listeners]) listener(message);
  };
  const forwarded = new Map<string, number>();
  const cut = new Set<string>();
  const fakePage = definePlugin({
    manifest: {
      id: 'fake-page',
      version: '1.0.0',
      tier: 'critical',
      provides: [StagePageService.ref],
      inject: [],
      permissions: [],
      process: 'in-process',
      config: Type.Object({}),
    },
    activate(ctx) {
      ctx.provide(StagePageService, {
        ready: true,
        send(message: ToPage) {
          if (message.kind === 'heartbeat') {
            report({ kind: 'heartbeat-ack' });
            return;
          }
          if (message.kind === 'token') return;
          sent.push(message);
          if (message.kind === 'audio') {
            const { sentenceId, pcm } = message;
            forwarded.set(sentenceId, (forwarded.get(sentenceId) ?? 0) + pcm.length);
          } else if (message.kind === 'truncate') {
            cut.add(message.sentenceId);
          } else if (message.kind === 'end' && !cut.has(message.sentenceId)) {
            const played = forwarded.get(message.sentenceId) ?? 0;
            report({ kind: 'started', sentenceId: message.sentenceId });
            report({ kind: 'ended', sentenceId: message.sentenceId, played });
          }
        },
        onMessage(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      });
    },
  });
  let speaker: { safety: SafetyFacade; stage: Stage } | undefined;
  const speakerPlugin = definePlugin({
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
      speaker = { safety: ctx.service(SafetyService), stage: ctx.service(StageService) };
    },
  });
  kernel = new Kernel({
    clock,
    safety: core.kernelHooks(),
    log: (event, fields = {}) => logs.push({ event, fields }),
  });
  kernel.provideScoped(SafetyService, ({ instanceId }) => safetyFacade(core, instanceId));
  kernel.provideCore(ClockService, clock);
  const entry = (id: string, plugin: string, grant: string[] = []) => ({
    id,
    plugin,
    config: {},
    disabled: false,
    explicitSwitch: false,
    grant,
  });
  kernel.add(
    [
      entry('page', 'fake-page'),
      entry('stage', 'stage-service'),
      entry('speaker', 'test-speaker', ['speech.output']),
    ],
    catalog(fakePage, stageService, speakerPlugin),
  );
  await kernel.settled();
  const mode = core.requestMode('M1');
  if (!mode.ok) throw new Error(mode.reason);
  const active = kernel;
  const handles = () => {
    if (!speaker) throw new Error('发声插件未激活');
    return speaker;
  };
  return {
    sent,
    logs,
    report,
    stage: () => handles().stage,
    /** 取得 Stage 音频输出许可后播放一句。 */
    play(info: SentenceInfo, audio: AsyncIterable<Int16Array>) {
      const { safety, stage } = handles();
      const granted = safety.grant(STAGE_AUDIO);
      if (!granted.ok) throw new Error(granted.reason);
      const lease: Lease = granted.lease;
      const result: Promise<PlaybackResult> = stage.play(info, audio, lease.token);
      return { lease, result, release: () => safety.release(lease) };
    },
    /** 发给页面的消息摘要：映射写出各码点的开始。 */
    summary() {
      return sent.map((m) => (m.kind === 'timing' ? `timing ${m.starts.join(',')}` : m.kind));
    },
    async close() {
      await active.shutdown();
      store.close();
    },
  };
}

const chunk = () => new Int16Array(100);

test('句子开始送插值的映射，细化时送更新，流结束按实际采样数修正后再送一次；没有变化不重发', async () => {
  const s = await setup();
  try {
    let starts: number[] = [0, 100, 200];
    async function* audio() {
      yield chunk();
      // 第二块音频带来时间戳，映射被细化。
      starts = [0, 120, 240];
      yield chunk();
      yield chunk();
      // 流结束：按实际总采样数修正。
      starts = [0, 120, 260];
    }
    const { lease, result } = s.play(
      { id: 's1', subtitle: '你好呀', sampleRate: 1000, subtitleStarts: () => starts },
      audio(),
    );
    assert.equal((await result).complete, true);
    assert.deepEqual(s.summary(), [
      'begin',
      'timing 0,100,200',
      'audio',
      'audio',
      'timing 0,120,240',
      'audio',
      'timing 0,120,260',
      'end',
    ]);
    for (const m of s.sent) {
      if (m.kind === 'timing') assert.deepEqual([m.sentenceId, m.token], ['s1', lease.token]);
    }
  } finally {
    await s.close();
  }
});

test('没有映射时不送；映射晚到时从有的那一刻起送', async () => {
  const s = await setup();
  try {
    async function* audio() {
      yield chunk();
      yield chunk();
    }
    await s.play({ id: 's1', subtitle: '你好', sampleRate: 1000 }, audio()).result;
    let starts: number[] | undefined;
    async function* later() {
      yield chunk();
      starts = [0, 100];
      yield chunk();
    }
    await s.play(
      { id: 's2', subtitle: '你好', sampleRate: 1000, subtitleStarts: () => starts },
      later(),
    ).result;
    assert.deepEqual(s.summary(), [
      'begin',
      'audio',
      'audio',
      'end',
      'begin',
      'audio',
      'audio',
      'timing 0,100',
      'end',
    ]);
  } finally {
    await s.close();
  }
});

test('不合格的映射不送，每句记一次日志，播放照常；之后合格的映射照常送', async () => {
  const s = await setup();
  try {
    const reads: Array<() => number[]> = [
      () => [0, 50, 20],
      () => [0, 1.5, 2],
      () => [0, 1, 2, 3],
      () => {
        throw new Error('坏映射');
      },
      () => [0, 10, 20],
    ];
    let read = 0;
    const subtitleStarts = () => (reads[Math.min(read++, reads.length - 1)] as () => number[])();
    async function* audio() {
      for (let i = 0; i < 5; i++) yield chunk();
    }
    const result = await s.play(
      { id: 's1', subtitle: '你好呀', sampleRate: 1000, subtitleStarts },
      audio(),
    ).result;
    assert.equal(result.complete, true);
    assert.deepEqual(
      s.summary().filter((kind) => kind.startsWith('timing')),
      ['timing 0,10,20'],
    );
    const invalid = s.logs.filter((l) => l.event === 'stage.timing-invalid');
    assert.equal(invalid.length, 1);
    assert.equal(invalid[0]?.fields.problem, '映射没有按码点不减');
  } finally {
    await s.close();
  }
});

test('要求截断后、许可失效后都不再送映射', async () => {
  const s = await setup();
  try {
    let starts = [0, 100];
    const gate = Promise.withResolvers<void>();
    async function* audio() {
      yield chunk();
      await gate.promise;
      starts = [0, 150];
      yield chunk();
      starts = [0, 200];
    }
    const first = s.play(
      { id: 's1', subtitle: '你好', sampleRate: 1000, subtitleStarts: () => starts },
      audio(),
    );
    await flush();
    s.stage().truncate('s1');
    // 页面的截断回报还没到：音频流继续产出，但映射不再发给这一句。
    gate.resolve();
    await flush();
    await flush();
    s.report({ kind: 'truncated', sentenceId: 's1', played: 50, reason: '要求截断' });
    assert.equal((await first.result).complete, false);
    const cut = s.summary().indexOf('truncate');
    assert.ok(cut > 0);
    assert.deepEqual(
      s
        .summary()
        .slice(cut)
        .filter((kind) => kind.startsWith('timing')),
      [],
    );

    // 许可在流中途失效：Stage 服务要求截断，之后不再送映射。
    const from = s.sent.length;
    let later = [0, 100];
    const second = Promise.withResolvers<void>();
    async function* audio2() {
      yield chunk();
      await second.promise;
      later = [0, 300];
      yield chunk();
    }
    const play = s.play(
      { id: 's2', subtitle: '你好', sampleRate: 1000, subtitleStarts: () => later },
      audio2(),
    );
    await flush();
    play.release();
    second.resolve();
    await flush();
    await flush();
    s.report({ kind: 'truncated', sentenceId: 's2', played: 0, reason: '令牌已变化' });
    assert.equal((await play.result).complete, false);
    const kinds = s.summary().slice(from);
    assert.deepEqual(kinds.slice(0, 4), ['begin', 'timing 0,100', 'audio', 'truncate']);
    assert.deepEqual(
      kinds.filter((kind) => kind.startsWith('timing')),
      ['timing 0,100'],
    );
  } finally {
    await s.close();
  }
});
