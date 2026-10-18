import { createServer } from 'node:net';
import {
  ClockService,
  catalog,
  definePlugin,
  Kernel,
  ManualClock,
  type PluginSecrets,
  type ResolvedEntry,
  SecretsService,
  secretPermission,
} from '@bellis/kernel';
import { type Decision, SafetyCore, SafetyService, safetyFacade } from '@bellis/safety';
import { MemorySecretStore, type SecretStore } from '@bellis/secret-store';
import {
  type Envelope,
  type FromPage,
  type PlaybackResult,
  type Presentation,
  type Stage,
  StageService,
} from '@bellis/stage';
import { StateStore } from '@bellis/store';
import Type from 'typebox';
import { type Avatar, AvatarService, VTS_SECRET, vtsAvatar } from '../src/index.ts';

/** 可以直接注入游标事件与包络的 Stage。 */
export class FakeStage implements Stage {
  readonly ready = true;
  readonly envelopes = new Map<string, Envelope>();
  presentation: Presentation = { delayMs: 0, samples: 0, source: 'none' };

  setPresentation(presentation: Presentation): void {
    this.presentation = presentation;
  }
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

  emit(event: FromPage): void {
    for (const listener of [...this.#listeners]) listener(event);
  }
}

/** 与宿主相同的规则：只放行授予的 `secret:<名字>`。 */
function scopedSecrets(store: SecretStore, permissions: ReadonlySet<string>): PluginSecrets {
  const check = (name: string) => {
    if (!permissions.has(secretPermission(name)))
      throw new Error(`没有权限 ${secretPermission(name)}`);
  };
  return {
    async read(name) {
      check(name);
      return store.get(name);
    },
    async write(name, value) {
      check(name);
      await store.set(name, value);
    },
    async delete(name) {
      check(name);
      return store.delete(name);
    },
  };
}

function entry(id: string, plugin: string, grant: string[], config = {}): ResolvedEntry {
  return { id, plugin, config, disabled: false, explicitSwitch: false, grant };
}

export const until = async (condition: () => boolean, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('条件未在时限内满足');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** 取一个当前空闲的本机端口。 */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== 'object' || address === null) throw new Error('取不到端口');
  return address.port;
}

export interface SetupOptions {
  url: string;
  /** 预先存入凭据服务的令牌。 */
  token?: string;
  config?: Record<string, unknown>;
}

/**
 * 形象插件与一个代表表情调用方的插件，跑在手动时钟、内存状态存储与真实安全核上；
 * Stage 换成可直接注入事件的假实现，凭据存在内存里。
 */
export async function setup(options: SetupOptions) {
  const clock = new ManualClock();
  const store = StateStore.open({ path: ':memory:' });
  store.recover();
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const log = (event: string, fields: Record<string, unknown> = {}) => logs.push({ event, fields });
  let kernel: Kernel | undefined;
  const core = new SafetyCore({
    store,
    clock,
    config: {
      simulation: false,
      leaseTtlMs: {},
      leaseCapabilities: {},
      presenceTtlMs: 60_000,
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
  kernel = new Kernel({ clock, safety: core.kernelHooks(), log });
  kernel.provideCore(ClockService, clock);
  kernel.provideScoped(SafetyService, ({ instanceId }) => safetyFacade(core, instanceId));
  const secrets = new MemorySecretStore();
  if (options.token !== undefined) await secrets.set(VTS_SECRET, options.token);
  kernel.provideScoped(SecretsService, ({ permissions }) => scopedSecrets(secrets, permissions));
  const stage = new FakeStage();
  kernel.provideCore(StageService, stage);

  // 代表需要表情的插件：自己申请授权，再交给形象执行。
  let authorize: ((payload: unknown, capabilities: string[]) => Promise<Decision>) | undefined;
  let next = 0;
  const caller = definePlugin({
    manifest: {
      id: 'avatar-caller',
      version: '1.0.0',
      tier: 'ordinary',
      provides: [],
      inject: [SafetyService.ref, AvatarService.ref],
      permissions: [],
      process: 'in-process',
      config: Type.Object({}),
    },
    activate(ctx) {
      const safety = ctx.service(SafetyService);
      authorize = (payload, capabilities) => {
        next += 1;
        return safety.authorize({
          key: `expression-${next}`,
          type: 'avatar.expression',
          target: 'avatar',
          payload,
          source: { origin: 'test', inputs: [], untrusted: false },
          capabilities,
          timeSensitive: true,
        });
      };
    },
  });
  kernel.add(
    [
      entry('avatar', 'avatar-vts', [secretPermission(VTS_SECRET)], {
        url: options.url,
        reconnectMs: 500,
        ...options.config,
      }),
      entry('caller', 'avatar-caller', ['avatar.expression']),
    ],
    catalog(vtsAvatar, caller),
  );
  await kernel.settled();
  const active = kernel;
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  return {
    clock,
    core,
    store,
    kernel: active,
    logs,
    secrets,
    stage,
    avatar(): Avatar {
      const found = active.services.resolve(AvatarService.name, AvatarService.major);
      if ('missing' in found) throw new Error(found.missing);
      return found.impl as Avatar;
    },
    state(id = 'avatar') {
      return active.snapshot().find((e) => e.id === id)?.state;
    },
    logged(event: string) {
      return logs.filter((entry) => entry.event === event);
    },
    authorize(payload: unknown, capabilities: string[]) {
      if (!authorize) throw new Error('调用方插件未激活');
      return authorize(payload, capabilities);
    },
    /** 推进手动时钟，每步之间让网络往返跑一跑。 */
    async run(ms: number, step = 10) {
      for (let elapsed = 0; elapsed < ms; elapsed += step) {
        clock.advance(Math.min(step, ms - elapsed));
        await flush();
      }
    },
    async close() {
      let done = false;
      const shutdown = active.shutdown().finally(() => {
        done = true;
      });
      while (!done) {
        clock.advance(10);
        await flush();
      }
      await shutdown;
      store.close();
    },
  };
}
