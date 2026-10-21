import {
  ClockService,
  Kernel,
  ManualClock,
  type PluginCatalog,
  RandomService,
  type ResolvedEntry,
  type ServiceToken,
  seededRandom,
  TraceService,
} from '@bellis/kernel';
import { type SimIrisBackend, SimIrisBackendService } from '@bellis/memory';
import { builtinPlugins, builtinProjections } from '@bellis/plugins';
import { type SafetyConfig, SafetyCore, SafetyService, safetyFacade } from '@bellis/safety';
import { ObsMetersService } from '@bellis/stage';
import { StateStore } from '@bellis/store';
import { MemoryObs } from './memory-obs.ts';

export const simSafety: SafetyConfig = {
  simulation: true,
  leaseTtlMs: { 'stage.audio': 2000, 'game.input': 500 },
  leaseCapabilities: { 'stage.audio': 'speech.output', 'game.input': 'game.input' },
  presenceTtlMs: 600_000,
  rateLimits: {},
  guardTimeoutMs: 200,
  emergency: { stageSource: 'Stage', safeScene: 'Safe', stopStream: false },
  unattendedGatesSatisfied: false,
};

export interface WorldOptions {
  entries: readonly ResolvedEntry[];
  /** 审核插件的显式开关（来自 profile）。 */
  moderationEnabled: boolean;
  safety?: Partial<SafetyConfig>;
  plugins?: PluginCatalog;
  /** 墙钟起点，用于事件时间戳。 */
  epochMs?: number;
  /** 种子：驱动随机数服务与同时到期定时器的先后。缺省为 0。 */
  seed?: number;
  /** 状态存储文件；缺省为内存数据库。模拟重启时需要文件。 */
  storePath?: string;
  /** 手动时钟的起始时刻（重启时接上之前的时间）。 */
  startAt?: number;
  /** 本次启动的标识，写进插件实例编号。 */
  bootId?: string;
  /** 模拟 Iris 的数据：代表进程外的服务，由仿真在各次启动之间保留。 */
  iris?: SimIrisBackend;
}

/** 追踪中的一条记录：各部分按发生顺序写入，时间为手动时钟的时刻。 */
export interface TraceEntry {
  seq: number;
  at: number;
  kind: string;
  data: Record<string, unknown>;
}

export interface LogEntry {
  event: string;
  fields: Record<string, unknown>;
}

/**
 * 进程内的完整世界：状态存储、安全核、插件内核与核心服务，全部由同一个手动时钟与种子驱动。
 * 用于全模拟链路测试与确定性仿真（R-07）。
 */
export class World {
  readonly clock: ManualClock;
  readonly store: StateStore;
  readonly storePath: string;
  readonly trace: TraceEntry[] = [];
  readonly obs = new MemoryObs();
  readonly safety: SafetyCore;
  readonly kernel: Kernel;
  readonly logs: LogEntry[] = [];

  constructor(options: WorldOptions) {
    const epoch = options.epochMs ?? Date.UTC(2026, 9, 14);
    const random = seededRandom(options.seed ?? 0);
    const shuffle = seededRandom((options.seed ?? 0) ^ 0x5bd1e995);
    // 零点对应墙钟起点：遥测的时间戳与事件时间戳在同一条墙钟时间线上。
    this.clock = new ManualClock(options.startAt ?? 0, (count) => shuffle.int(0, count - 1), epoch);
    const log = (event: string, fields: Record<string, unknown> = {}) =>
      this.logs.push({ event, fields });
    this.storePath = options.storePath ?? ':memory:';
    this.store = StateStore.open({
      path: this.storePath,
      projections: builtinProjections,
      now: () => epoch + Math.floor(this.clock.now()),
    });
    this.store.recover();
    // 发言结果与投票的事实同时写进追踪，与 Stage 的回报、送出的弹幕排在同一条时间线上。
    this.store.subscribe((event) => {
      if (event.type === 'utterance.played')
        this.record('fact.utterance', { ...(event.data as object) });
      else if (event.type.startsWith('vote.'))
        this.record(`fact.${event.type}`, { ...(event.data as object) });
      else if (event.type.startsWith('memory.'))
        this.record(`fact.${event.type}`, { factSeq: event.seq, ...(event.data as object) });
    });
    let kernel: Kernel | undefined;
    this.safety = new SafetyCore({
      store: this.store,
      clock: this.clock,
      config: { ...simSafety, ...options.safety },
      obs: this.obs,
      permissionsOf: (holder) => kernel?.permissionsOf(holder),
      watchdogConnected: () => true,
      log,
    });
    this.kernel = new Kernel({
      clock: this.clock,
      bootId: options.bootId ?? `s${options.seed ?? 0}`,
      safety: this.safety.kernelHooks(),
      log,
      onTransition: (transition) => {
        log('plugin.transition', { ...transition });
        const tier = this.kernel.snapshot().find((e) => e.id === transition.entryId)?.tier;
        if (tier) this.safety.onPluginTransition(transition, tier);
      },
    });
    kernel = this.kernel;
    this.safety.control.subscribe((signal) => this.record(`control.${signal.kind}`, { ...signal }));
    this.kernel.provideCore(ClockService, this.clock);
    this.kernel.provideCore(RandomService, random);
    this.kernel.provideCore(TraceService, { record: (kind, data) => this.record(kind, data) });
    this.kernel.provideScoped(SafetyService, ({ instanceId, permissions }) =>
      safetyFacade(this.safety, instanceId, permissions),
    );
    // 仿真里没有 OBS 音量表：stage-sync 一直用配置的初值作呈现延迟。
    if (options.iris) this.kernel.provideCore(SimIrisBackendService, options.iris);
    this.kernel.provideCore(ObsMetersService, {
      connect: () => Promise.reject(new Error('仿真里没有 OBS 音量表')),
    });
    this.safety.setModeration(options.moderationEnabled);
    this.kernel.add(options.entries, options.plugins ?? builtinPlugins);
  }

  record(kind: string, data: Record<string, unknown>): void {
    this.trace.push({ seq: this.trace.length, at: this.clock.now(), kind, data });
  }

  /**
   * 模拟进程崩溃：不做任何收尾，直接放弃这个世界（旧时钟不再推进，旧插件不再运行）。
   * 返回在同一个状态存储上重启所需的信息。
   */
  crash(): { storePath: string; now: number } {
    this.store.close();
    return { storePath: this.storePath, now: this.clock.now() };
  }

  /** 取得某个服务的实现（测试用）。 */
  service<T>(token: ServiceToken<T>): T {
    const found = this.kernel.services.resolve(token.name, token.major);
    if ('missing' in found) throw new Error(found.missing);
    return found.impl as T;
  }

  /** 让已经排队的微任务跑完。 */
  async flush(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  /** 推进时钟 `ms` 毫秒，每步之间让异步流程跑完。 */
  async run(ms: number, step = 10): Promise<void> {
    await this.flush();
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      this.clock.advance(Math.min(step, ms - elapsed));
      await this.flush();
    }
  }

  /** 推进时钟直到条件满足。 */
  async until(condition: () => boolean, limitMs = 60_000, step = 10): Promise<void> {
    await this.flush();
    for (let elapsed = 0; !condition(); elapsed += step) {
      if (elapsed > limitMs) throw new Error(`条件未在模拟时间 ${limitMs}ms 内满足`);
      this.clock.advance(step);
      await this.flush();
    }
  }

  events(type?: string) {
    const all = this.store.events();
    return type ? all.filter((event) => event.type === type) : all;
  }

  /** 停止：卸载插件期间继续推进时钟，收尾的截止时间才会到期。 */
  async close(): Promise<void> {
    let done = false;
    const shutdown = this.kernel.shutdown().finally(() => {
      done = true;
    });
    for (let waited = 0; !done && waited < 600_000; waited += 10) {
      this.clock.advance(10);
      await this.flush();
    }
    await shutdown;
    this.store.close();
  }
}
