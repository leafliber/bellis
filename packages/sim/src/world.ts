import {
  ClockService,
  Kernel,
  ManualClock,
  type PluginCatalog,
  type ResolvedEntry,
  type ServiceToken,
} from '@bellis/kernel';
import { builtinPlugins } from '@bellis/plugins';
import { type SafetyConfig, SafetyCore, SafetyService, safetyFacade } from '@bellis/safety';
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
}

export interface LogEntry {
  event: string;
  fields: Record<string, unknown>;
}

/**
 * 进程内的完整世界：状态存储（内存 SQLite）、安全核、插件内核与核心服务，全部由同一个手动时钟驱动。
 * 用于全模拟链路测试与确定性仿真（R-07）。
 */
export class World {
  readonly clock = new ManualClock();
  readonly store: StateStore;
  readonly obs = new MemoryObs();
  readonly safety: SafetyCore;
  readonly kernel: Kernel;
  readonly logs: LogEntry[] = [];

  constructor(options: WorldOptions) {
    const epoch = options.epochMs ?? Date.UTC(2026, 9, 14);
    const log = (event: string, fields: Record<string, unknown> = {}) =>
      this.logs.push({ event, fields });
    this.store = StateStore.open({
      path: ':memory:',
      now: () => epoch + Math.floor(this.clock.now()),
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
      safety: this.safety.kernelHooks(),
      log,
      onTransition: (transition) => {
        log('plugin.transition', { ...transition });
        const tier = this.kernel.snapshot().find((e) => e.id === transition.entryId)?.tier;
        if (tier) this.safety.onPluginTransition(transition, tier);
      },
    });
    kernel = this.kernel;
    this.kernel.provideCore(ClockService, this.clock);
    this.kernel.provideScoped(SafetyService, ({ instanceId }) =>
      safetyFacade(this.safety, instanceId),
    );
    this.safety.setModeration(options.moderationEnabled);
    this.kernel.add(options.entries, options.plugins ?? builtinPlugins);
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

  async close(): Promise<void> {
    await this.kernel.shutdown();
    this.store.close();
  }
}
