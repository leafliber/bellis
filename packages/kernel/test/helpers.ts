import Type from 'typebox';
import {
  catalog,
  definePlugin,
  defineService,
  Kernel,
  type KernelOptions,
  type PluginDefinition,
  type QuiesceTimeout,
  type ResolvedEntry,
  systemClock,
} from '../src/index.ts';

export const Greeter = defineService<{ greet(): string }>('greeter', 1);

export function harness(options: Partial<KernelOptions> = {}) {
  const log: string[] = [];
  const timeouts: QuiesceTimeout[] = [];
  let maintenance = false;
  const kernel = new Kernel({
    clock: systemClock(),
    safety: {
      revokeLeases: (instanceId) => {
        log.push(`revoke ${instanceId}`);
      },
      quiesceTimedOut: (event) => {
        timeouts.push(event);
      },
      inMaintenance: () => maintenance,
    },
    activateTimeoutMs: 200,
    quiesceTimeoutMs: 100,
    disposerTimeoutMs: 100,
    retryDelaysMs: [20, 20],
    ...options,
  });
  return {
    kernel,
    log,
    timeouts,
    setMaintenance(value: boolean) {
      maintenance = value;
    },
    state(id: string) {
      const entry = kernel.snapshot().find((e) => e.id === id);
      if (!entry) throw new Error(`没有条目 ${id}`);
      return entry;
    },
  };
}

export function entry(id: string, plugin = id, extra: Partial<ResolvedEntry> = {}): ResolvedEntry {
  return { id, plugin, config: {}, disabled: false, explicitSwitch: false, grant: [], ...extra };
}

const base = {
  version: '1.0.0',
  tier: 'ordinary' as const,
  provides: [] as string[],
  inject: [] as string[],
  permissions: [] as string[],
  process: 'in-process' as const,
  config: Type.Object({}),
};

export function provider(
  id: string,
  log: string[],
  options: { word?: string; tier?: 'critical' | 'ordinary'; major?: number } = {},
): PluginDefinition {
  const token = defineService<{ greet(): string }>('greeter', options.major ?? 1);
  return definePlugin({
    manifest: { ...base, id, tier: options.tier ?? 'ordinary', provides: [token.ref] },
    activate(ctx) {
      log.push(`activate ${id}`);
      ctx.provide(token, { greet: () => options.word ?? 'hello' });
      ctx.register(() => {
        log.push(`dispose ${id}`);
      });
    },
    quiesce() {
      log.push(`quiesce ${id}`);
    },
  });
}

export function consumer(id: string, log: string[], inject = [Greeter.ref]): PluginDefinition {
  return definePlugin({
    manifest: { ...base, id, inject },
    activate(ctx) {
      const greeter = inject[0]?.endsWith('?') ? ctx.optional(Greeter) : ctx.service(Greeter);
      log.push(`activate ${id} ${greeter?.greet() ?? '-'}`);
      ctx.register(() => {
        log.push(`dispose ${id}`);
      });
    },
    quiesce() {
      log.push(`quiesce ${id}`);
    },
  });
}

export { base, catalog };
