import {
  type Candidate,
  type Candidates,
  CandidatesService,
  VoteEnded,
  type VoteEndedNotice,
  VoteService,
  type VoteStatus,
  type Votes,
} from '@bellis/audience';
import {
  ClockService,
  catalog,
  Kernel,
  ManualClock,
  RandomService,
  type ResolvedEntry,
  seededRandom,
} from '@bellis/kernel';
import { type Memory, MemoryService } from '@bellis/memory';
import { SafetyCore, SafetyService, safetyFacade } from '@bellis/safety';
import {
  type Speech,
  type SpeechRequest,
  SpeechService,
  type UtteranceOutcome,
} from '@bellis/speech';
import { StateStore } from '@bellis/store';
import {
  emptyView,
  memoryTelemetry,
  parseLines,
  type TelemetryMemory,
  TelemetryMemoryService,
  type TelemetryView,
  type ViewSpan,
} from '@bellis/telemetry';
import { director, type LlmCallOptions, type LlmRequest, LlmService } from '../src/index.ts';

/** 一次模型调用：测试决定它何时、以什么结果结束。 */
export interface PendingCall {
  request: LlmRequest;
  signal: AbortSignal;
  options: LlmCallOptions | undefined;
  resolve(output: string): void;
  reject(error: unknown): void;
}

export interface Setup {
  /** 决策插件的配置。 */
  config?: Record<string, unknown>;
  /** 观众实际听到的近期发言。 */
  heard?: string[];
  /** 进行中的投票（`vote@1` 的 `current()`）；不给时投票插件不在场。 */
  vote?: VoteStatus | null;
  /** 记忆（`memory@1`）；不给时记忆插件不在场。 */
  memory?: Memory;
  telemetry?: boolean;
}

let nextCandidate = 0;

/** 一个分诊后的候选（字段都可以覆盖）。 */
export function candidate(overrides: Partial<Candidate> = {}): Candidate {
  nextCandidate += 1;
  const id = overrides.id ?? `c-${nextCandidate}`;
  return {
    id,
    sources: [`d${nextCandidate}`],
    viewers: [`open-id-${nextCandidate}`],
    name: `观众${nextCandidate}`,
    text: `弹幕${nextCandidate}`,
    count: 1,
    injection: false,
    receivedAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

export const speak = (text: string, replyTo?: string) =>
  JSON.stringify({ action: 'speak', text, ...(replyTo ? { replyTo } : {}) });

export const silence = JSON.stringify({ action: 'silence', reason: '没什么要说的' });

/**
 * 决策插件的小世界：手动时钟、真实的安全核（仿真模式，M0）与状态存储（内存），候选、发声与投票是可控的桩，
 * 模型由测试逐次应答。
 */
export async function world(setup: Setup = {}) {
  const clock = new ManualClock(0);
  const store = StateStore.open({ path: ':memory:' });
  store.recover();
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const log = (event: string, fields: Record<string, unknown> = {}) => logs.push({ event, fields });
  let kernel: Kernel | undefined;
  const safety = new SafetyCore({
    store,
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
  const host = new Kernel({ clock, safety: safety.kernelHooks(), log, bootId: 't' });
  kernel = host;

  const calls: PendingCall[] = [];
  host.provideCore(LlmService, {
    model: { provider: 'test', name: 'test-model' },
    complete(request, signal, options) {
      return new Promise<string>((resolve, reject) =>
        calls.push({ request, signal, options, resolve, reject }),
      );
    },
  });

  const pending: Candidate[] = [];
  const available = new Set<() => void>();
  const candidates: Candidates = {
    take(max) {
      return pending.splice(0, max);
    },
    onAvailable(listener) {
      available.add(listener);
      return () => available.delete(listener);
    },
    get size() {
      return pending.length;
    },
  };
  host.provideCore(CandidatesService, candidates);

  const spoken: SpeechRequest[] = [];
  /** 每段发言的结束：测试决定观众听到了什么。 */
  const finish: Array<(outcome: UtteranceOutcome) => void> = [];
  const heard: UtteranceOutcome[] = (setup.heard ?? []).map((text, i) => ({
    id: `h${i}`,
    source: 'chatter',
    heard: text,
    interruptedMidSentence: false,
    end: 'complete',
    skipped: [],
  }));
  const speech: Speech = {
    request(request) {
      spoken.push(request);
      return new Promise((resolve) => finish.push(resolve));
    },
    softStop() {},
    heard: () => heard,
  };
  host.provideCore(SpeechService, speech);

  const voteRequests: unknown[] = [];
  if (setup.vote !== undefined) {
    const status = setup.vote;
    const votes: Votes = {
      async start(request) {
        voteRequests.push(request);
        return { ok: true, voteId: request.id };
      },
      current: () => status ?? undefined,
    };
    host.provideCore(VoteService, votes);
  }

  if (setup.memory) host.provideCore(MemoryService, setup.memory);
  host.provideCore(ClockService, clock);
  host.provideCore(RandomService, seededRandom(1));
  host.provideScoped(SafetyService, ({ instanceId, permissions }) =>
    safetyFacade(safety, instanceId, permissions),
  );
  safety.setModeration(false);
  const entries: ResolvedEntry[] = [
    {
      id: 'director',
      plugin: 'director',
      config: setup.config ?? {},
      disabled: false,
      explicitSwitch: false,
      grant: [],
    },
    ...(setup.telemetry
      ? [
          {
            id: 'telemetry',
            plugin: 'telemetry-memory',
            config: {},
            disabled: false,
            explicitSwitch: false,
            grant: [],
          },
        ]
      : []),
  ];
  host.add(entries, catalog(director, memoryTelemetry));
  await host.settled();
  const mode = safety.requestMode('M0');
  if (!mode.ok) throw new Error(mode.reason);

  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const view = (): TelemetryView => {
    const found = host.services.resolve(TelemetryMemoryService.name, TelemetryMemoryService.major);
    if ('missing' in found) return emptyView();
    return parseLines((found.impl as TelemetryMemory).lines);
  };
  return {
    kernel: host,
    clock,
    safety,
    store,
    logs,
    calls,
    spoken,
    finish,
    voteRequests,
    flush,
    /** 新一批候选到达。 */
    async arrive(...list: Candidate[]) {
      pending.push(...list);
      for (const listener of [...available]) listener();
      await flush();
    },
    /** 投票正常结束（`vote.ended` 扩展点）。 */
    async voteEnded(notice: VoteEndedNotice) {
      host.extensions.observe(VoteEnded, notice);
      await flush();
    },
    /** 推进时钟，每步之间让异步流程跑完。 */
    async advance(ms: number, step = 10) {
      for (let elapsed = 0; elapsed < ms; elapsed += step) {
        clock.advance(Math.min(step, ms - elapsed));
        await flush();
      }
    },
    /** 第 n 次（从 0 起）模型调用；还没发生时抛错。 */
    call(n: number): PendingCall {
      const found = calls[n];
      if (!found) throw new Error(`第 ${n} 次模型调用还没发生（共 ${calls.length} 次）`);
      return found;
    },
    /** 某种日志的字段（去掉内核加上的条目与实例编号）。 */
    logged: (event: string) =>
      logs
        .filter((l) => l.event === event)
        .map(({ fields: { entry: _entry, instance: _instance, ...rest } }) => rest),
    events: (type: string) => store.events().filter((e) => e.type === type),
    spans(): ViewSpan[] {
      return view().spans;
    },
    /** 某个时长直方图（秒）的原值（按写出的顺序）。 */
    metric(name: string): number[] {
      return view().metrics.get(`${name} s`)?.values ?? [];
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
      store.close();
    },
  };
}

export type World = Awaited<ReturnType<typeof world>>;
