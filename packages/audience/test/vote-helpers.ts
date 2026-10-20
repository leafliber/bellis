import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClockService,
  catalog,
  definePlugin,
  Kernel,
  ManualClock,
  type ResolvedEntry,
  type ServiceToken,
} from '@bellis/kernel';
import { SafetyCore, SafetyService, safetyFacade } from '@bellis/safety';
import {
  type Speech,
  type SpeechRequest,
  SpeechService,
  type UtteranceEnd,
  type UtteranceOutcome,
} from '@bellis/speech';
import { SimulatedCrash, StateStore } from '@bellis/store';
import Type from 'typebox';
import {
  type Danmaku,
  type DanmakuGap,
  DanmakuService,
  type VoteRequest,
  VoteService,
  type Votes,
  vote,
  voteLedger,
} from '../src/index.ts';

const EPOCH = Date.UTC(2026, 9, 20);

/** 假发声的一次回应：结束方式、被跳过的句数与耗时（手动时钟上）。 */
export interface SpeechScript {
  end?: UtteranceEnd;
  skipped?: number;
  delayMs?: number;
  reason?: string;
}

export interface VoteWorldOptions {
  /** 状态存储文件；同一个文件上重启。缺省新建临时文件。 */
  path?: string;
  /** 手动时钟的起点（重启时接上之前的时间）。 */
  startAt?: number;
  bootId?: string;
  /** 投票插件的授予；缺省授予 vote.start。 */
  grant?: string[];
  config?: Record<string, unknown>;
  /** 是否切到 M0（缺省是）；否则停在安全停止。 */
  m0?: boolean;
  /** 状态存储写入点的故障注入：返回 true 的写入点模拟崩溃（关闭存储后抛 SimulatedCrash）。 */
  crashAt?: (point: string) => boolean;
}

export function entry(
  id: string,
  plugin: string,
  extra: Partial<ResolvedEntry> = {},
): ResolvedEntry {
  return { id, plugin, config: {}, disabled: false, explicitSwitch: false, grant: [], ...extra };
}

/**
 * 投票插件的小世界：真实的状态存储（文件，注册投票账本）、安全核（仿真模式）与插件内核，全部由手动时钟驱动；
 * 发声与弹幕来源换成可控的假实现。崩溃即关闭存储、放弃这个世界，在同一个文件上重启。
 */
export async function voteWorld(options: VoteWorldOptions = {}) {
  const path = options.path ?? join(tmpdir(), `bellis-vote-${randomBytes(6).toString('hex')}.db`);
  const clock = new ManualClock(options.startAt ?? 0);
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const log = (event: string, fields: Record<string, unknown> = {}) => logs.push({ event, fields });
  let closed = false;
  const closeStore = () => {
    if (closed) return;
    closed = true;
    opened.close();
  };
  const opened: StateStore = StateStore.open({
    path,
    projections: [voteLedger],
    now: () => EPOCH + Math.floor(clock.now()),
    fault: (point) => {
      if (!closed && options.crashAt?.(point)) {
        closeStore();
        throw new SimulatedCrash(point);
      }
    },
  });
  opened.recover();
  let kernel: Kernel | undefined;
  const safety = new SafetyCore({
    store: opened,
    clock,
    config: {
      simulation: true,
      leaseTtlMs: {},
      leaseCapabilities: {},
      presenceTtlMs: 600_000,
      rateLimits: {},
      guardTimeoutMs: 200,
      emergency: { stageSource: 'Stage', safeScene: 'Safe', stopStream: false },
      unattendedGatesSatisfied: false,
    },
    obs: { ready: true, run: async () => ({ ok: true, results: [] }) },
    permissionsOf: (holder) => kernel?.permissionsOf(holder),
    watchdogConnected: () => true,
    log,
  });

  // 假发声：记下每个请求，按脚本在手动时钟上给出结果。
  const speechCalls: SpeechRequest[] = [];
  let script: (request: SpeechRequest) => SpeechScript = () => ({ delayMs: 1000 });
  const fakeSpeech = definePlugin({
    manifest: {
      id: 'fake-speech',
      version: '0.0.0',
      tier: 'ordinary',
      provides: [SpeechService.ref],
      inject: [ClockService.ref],
      permissions: [],
      process: 'in-process',
      config: Type.Object({}),
    },
    activate(ctx) {
      const speech: Speech = {
        request(request) {
          speechCalls.push(request);
          const { end = 'complete', skipped = 0, delayMs = 0, reason } = script(request);
          const outcome: UtteranceOutcome = {
            id: request.id,
            source: request.source,
            heard: end === 'complete' && typeof request.text === 'string' ? request.text : '',
            interruptedMidSentence: false,
            end,
            ...(reason === undefined ? {} : { reason }),
            skipped: Array.from({ length: skipped }, (_, index) => ({ index, reason: '被拦下' })),
          };
          return new Promise((resolve) => clock.setTimeout(() => resolve(outcome), delayMs));
        },
        softStop() {},
        heard: () => [],
      };
      ctx.provide(SpeechService, speech);
    },
  });

  // 假弹幕来源：测试直接送弹幕、开关缺口。
  const danmakuListeners = new Set<(danmaku: Danmaku) => void>();
  const gapListeners = new Set<(gap: DanmakuGap | undefined) => void>();
  let gap: DanmakuGap | undefined;
  const fakeDanmaku = definePlugin({
    manifest: {
      id: 'fake-danmaku',
      version: '0.0.0',
      tier: 'ordinary',
      provides: [DanmakuService.ref],
      inject: [],
      permissions: [],
      process: 'in-process',
      config: Type.Object({}),
    },
    activate(ctx) {
      ctx.provide(DanmakuService, {
        subscribe(listener) {
          danmakuListeners.add(listener);
          return () => danmakuListeners.delete(listener);
        },
        gap: () => gap,
        onGap(listener) {
          gapListeners.add(listener);
          return () => gapListeners.delete(listener);
        },
      });
    },
  });

  const host = new Kernel({
    clock,
    safety: safety.kernelHooks(),
    log,
    bootId: options.bootId ?? 'b0',
    retryDelaysMs: [],
  });
  kernel = host;
  host.provideCore(ClockService, clock);
  host.provideScoped(SafetyService, ({ instanceId, permissions }) =>
    safetyFacade(safety, instanceId, permissions),
  );
  host.add(
    [
      entry('speech', 'fake-speech'),
      entry('danmaku', 'fake-danmaku'),
      entry('vote', 'audience-vote', {
        grant: options.grant ?? ['vote.start'],
        config: options.config ?? {},
      }),
    ],
    catalog(fakeSpeech, fakeDanmaku, vote),
  );
  await host.settled();
  if (options.m0 ?? true) {
    const mode = safety.requestMode('M0');
    if (!mode.ok) throw new Error(mode.reason);
  }

  let seq = 0;
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const world = {
    path,
    clock,
    store: opened,
    safety,
    kernel: host,
    logs,
    speechCalls,
    /** 换掉假发声的脚本。 */
    speech(next: (request: SpeechRequest) => SpeechScript) {
      script = next;
    },
    service<T>(token: ServiceToken<T>): T {
      const found = host.services.resolve(token.name, token.major);
      if ('missing' in found) throw new Error(found.missing);
      return found.impl as T;
    },
    votes(): Votes {
      return world.service(VoteService);
    },
    /** 发起投票并等它返回。 */
    start(request: Partial<VoteRequest> = {}) {
      return world.votes().start({ ...ballotRequest(), ...request });
    },
    /** 一条弹幕现在到达。 */
    send(viewer: string, text: string) {
      seq += 1;
      const danmaku: Danmaku = { id: `d${seq}`, viewer, nickname: viewer, text };
      for (const listener of [...danmakuListeners]) listener(danmaku);
    },
    /** 在手动时钟的某个时刻送一条弹幕（定时器在调用时设好，同一时刻先于之后设的定时器触发）。 */
    sendAt(atMs: number, viewer: string, text: string) {
      clock.setTimeout(() => world.send(viewer, text), Math.max(0, atMs - clock.now()));
    },
    setGap(next: DanmakuGap | undefined) {
      gap = next;
      for (const listener of [...gapListeners]) listener(next);
    },
    events: (type: string) =>
      opened
        .events()
        .filter((e) => e.type === type)
        .map((e) => e.data as Record<string, unknown>),
    flush,
    async advance(ms: number, step = 10) {
      await flush();
      for (let elapsed = 0; elapsed < ms; elapsed += step) {
        clock.advance(Math.min(step, ms - elapsed));
        await flush();
      }
    },
    /** 模拟进程崩溃：不做任何收尾，关闭存储，返回在同一个文件上重启所需的信息。 */
    crash() {
      closeStore();
      return { path, startAt: clock.now() };
    },
    async close() {
      let done = false;
      const shutdown = host.shutdown().finally(() => {
        done = true;
      });
      for (let waited = 0; !done && waited < 60_000; waited += 10) {
        clock.advance(10);
        await flush();
      }
      await shutdown;
      closeStore();
    },
    /** 删掉状态存储文件。 */
    remove() {
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    },
  };
  return world;
}

export type VoteWorld = Awaited<ReturnType<typeof voteWorld>>;

let next = 0;
/** 一次发起：三个选项、30 秒。 */
export function ballotRequest(overrides: Partial<VoteRequest> = {}): VoteRequest {
  next += 1;
  return {
    id: `req-${next}`,
    question: '下一把玩什么？',
    options: ['魔女审判', '逆转裁判', '雀魂'],
    durationSec: 30,
    inputs: ['d0'],
    untrusted: true,
    ...overrides,
  };
}
