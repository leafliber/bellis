import { type Danmaku, DanmakuService, type DanmakuSource } from '@bellis/audience';
import {
  ClockService,
  catalog,
  Kernel,
  ManualClock,
  RandomService,
  type ResolvedEntry,
  seededRandom,
  TraceService,
} from '@bellis/kernel';
import { SafetyCore, SafetyService, safetyFacade } from '@bellis/safety';
import { type UtteranceOutcome, UtterancePlayed } from '@bellis/speech';
import { StateStore } from '@bellis/store';
import {
  emptyView,
  memoryTelemetry,
  parseLines,
  type TelemetryMemory,
  TelemetryMemoryService,
  type TelemetryView,
} from '@bellis/telemetry';
import {
  type Memory,
  MemoryService,
  memory,
  memoryLedger,
  SimIrisBackend,
  SimIrisBackendService,
  simIris,
} from '../src/index.ts';

export const ENTRY = 'sim:room';

export interface Setup {
  /** 记忆插件的配置（缺省只给入口 ID）。 */
  config?: Record<string, unknown>;
  /** 模拟 Iris 的配置。 */
  iris?: Record<string, unknown>;
  /** 模拟 Iris 的数据：跨“重启”保留。 */
  backend?: SimIrisBackend;
  /** 状态存储文件；缺省为内存数据库。模拟重启时需要文件。 */
  storePath?: string;
  /** 记忆插件的授权；缺省授予 memory.write。 */
  grant?: string[];
  /**
   * 直播间入口还不存在（新部署）：模拟 Iris 对它的召回准备返回 404，记忆插件应当自己建立入口。
   * 缺省为 false：入口早已存在。
   */
  freshEntry?: boolean;
  /** 起始模式：缺省切到 M0；`safe-stop` 时保持安全停止。 */
  mode?: 'M0' | 'safe-stop';
  telemetry?: boolean;
  /** 本次启动的标识（写进插件实例编号）。 */
  bootId?: string;
  /** 手动时钟的起始时刻。 */
  startAt?: number;
}

/**
 * 记忆插件的小世界：手动时钟、真实的安全核（仿真模式）与状态存储（注册记忆账本），模拟 Iris，
 * 可控的弹幕来源；发声结果经扩展点 `speech.played` 送出。
 */
export async function world(setup: Setup = {}) {
  const clock = new ManualClock(setup.startAt ?? 0);
  const store = StateStore.open({
    path: setup.storePath ?? ':memory:',
    projections: [memoryLedger],
    now: () => Date.UTC(2026, 9, 22) + Math.floor(clock.now()),
  });
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
  const host = new Kernel({
    clock,
    safety: safety.kernelHooks(),
    log,
    bootId: setup.bootId ?? 't',
  });
  kernel = host;
  const backend = setup.backend ?? new SimIrisBackend();
  if (!setup.freshEntry) backend.createEntry(ENTRY);
  const trace: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const listeners = new Set<(danmaku: Danmaku) => void>();
  const source: DanmakuSource = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  host.provideCore(ClockService, clock);
  host.provideCore(RandomService, seededRandom(7));
  host.provideCore(SimIrisBackendService, backend);
  host.provideCore(DanmakuService, source);
  host.provideCore(TraceService, { record: (kind, data) => trace.push({ kind, data }) });
  host.provideScoped(SafetyService, ({ instanceId, permissions }) =>
    safetyFacade(safety, instanceId, permissions),
  );
  safety.setModeration(false);
  const entry = (
    id: string,
    plugin: string,
    extra: Partial<ResolvedEntry> = {},
  ): ResolvedEntry => ({
    id,
    plugin,
    config: {},
    disabled: false,
    explicitSwitch: false,
    grant: [],
    ...extra,
  });
  host.add(
    [
      entry('iris', 'iris-sim', { config: setup.iris ?? {} }),
      entry('memory', 'memory', {
        config: { entryId: ENTRY, ...setup.config },
        grant: setup.grant ?? ['memory.write'],
      }),
      ...(setup.telemetry ? [entry('telemetry', 'telemetry-memory')] : []),
    ],
    catalog(simIris, memory, memoryTelemetry),
  );
  await host.settled();
  if ((setup.mode ?? 'M0') === 'M0') {
    const mode = safety.requestMode('M0');
    if (!mode.ok) throw new Error(mode.reason);
  }

  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const advance = async (ms: number, step = 10) => {
    await flush();
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      clock.advance(Math.min(step, ms - elapsed));
      await flush();
    }
  };
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
    backend,
    trace,
    logs,
    flush,
    advance,
    state: (id = 'memory') => host.snapshot().find((e) => e.id === id),
    memory(): Memory {
      const found = host.services.resolve(MemoryService.name, MemoryService.major);
      if ('missing' in found) throw new Error(found.missing);
      return found.impl as Memory;
    },
    ledger: () => store.view(memoryLedger),
    events: (type: string) => store.events().filter((e) => e.type === type),
    logged: (event: string) =>
      logs
        .filter((l) => l.event === event)
        .map(({ fields: { entry: _entry, instance: _instance, ...rest } }) => rest),
    /** 平台送来一条弹幕。 */
    async danmaku(d: Partial<Danmaku> & { id: string; viewer: string; text: string }) {
      for (const listener of [...listeners]) listener({ nickname: '小明', ...d });
      await flush();
    },
    /** 一段发言结束（与发声仲裁记下 utterance.played 之后分发的一样）。 */
    async played(id: string, heard: string, extra: Partial<UtteranceOutcome> = {}) {
      host.extensions.observe(UtterancePlayed, {
        id,
        source: 'chatter',
        heard,
        interruptedMidSentence: false,
        end: 'complete',
        skipped: [],
        ...extra,
      });
      await flush();
    },
    spans: () => view().spans,
    /** 写出的遥测原文（JSONL 行）：核对不含内容。 */
    telemetryText(): string {
      const found = host.services.resolve(
        TelemetryMemoryService.name,
        TelemetryMemoryService.major,
      );
      return 'missing' in found ? '' : (found.impl as TelemetryMemory).lines.join('\n');
    },
    metric: (name: string) => view().metrics.get(`${name} s`)?.values ?? [],
    /** 模拟进程崩溃：不卸载插件，直接关掉状态存储。 */
    crash() {
      store.close();
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
