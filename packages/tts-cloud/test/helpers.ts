import {
  ClockService,
  catalog,
  Kernel,
  type PluginSecrets,
  type ResolvedEntry,
  SecretsService,
  type ServiceToken,
  secretPermission,
  systemClock,
} from '@bellis/kernel';
import { SafetyCore, SafetyService, safetyFacade } from '@bellis/safety';
import { MemorySecretStore } from '@bellis/secret-store';
import { simTts, speechArbiter } from '@bellis/speech';
import { simStagePage, stageService } from '@bellis/stage';
import { StateStore } from '@bellis/store';
import type { EngineEnv, EngineStream, EngineTimeouts, WireEvent } from '../src/index.ts';
import { cloudTts } from '../src/index.ts';

export const timeouts: EngineTimeouts = {
  connectTimeoutMs: 1000,
  firstAudioTimeoutMs: 1000,
  stallTimeoutMs: 1000,
  cancelTimeoutMs: 500,
  idleCloseMs: 5000,
};

export function env(secret: string | undefined, wire: WireEvent[] = []): EngineEnv {
  return {
    clock: systemClock(),
    secret: async () => secret,
    observe: (event) => wire.push(event),
  };
}

/** 读完一路合成，收集音频与最后一次时间戳。 */
export async function collect(stream: EngineStream) {
  const pcm: number[] = [];
  let audioChunks = 0;
  let words: ReadonlyArray<{ text: string; startMs: number; endMs: number }> = [];
  for await (const chunk of stream.chunks) {
    if (chunk.kind === 'audio') {
      audioChunks += 1;
      pcm.push(...chunk.pcm);
    } else words = chunk.words;
  }
  return { pcm, words, audioChunks };
}

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function entry(
  id: string,
  plugin: string,
  extra: Partial<ResolvedEntry> = {},
): ResolvedEntry {
  return { id, plugin, config: {}, disabled: false, explicitSwitch: false, grant: [], ...extra };
}

/** 云端 TTS 插件需要的全部权限（含本机假服务器的主机）。 */
export const CLOUD_GRANT = [
  'net.egress:api.minimax.cn',
  'net.egress:openspeech.bytedance.com',
  'net.egress:127.0.0.1',
  'secret:minimax',
  'secret:volcengine',
];

/**
 * 真实时钟下的小世界：状态存储（内存）、安全核（仿真模式，M0）、插件内核，
 * 凭据服务按授予的权限放行（与宿主的实现一致），凭据存在内存里。
 */
export async function world(
  entries: readonly ResolvedEntry[],
  secrets: Record<string, string> = {},
) {
  const clock = systemClock();
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
      leaseTtlMs: { 'stage.audio': 2000 },
      leaseCapabilities: { 'stage.audio': 'speech.output' },
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
    activateTimeoutMs: 2000,
    retryDelaysMs: [],
  });
  kernel = host;
  const memory = new MemorySecretStore();
  for (const [name, value] of Object.entries(secrets)) await memory.set(name, value);
  host.provideCore(ClockService, clock);
  host.provideScoped(SafetyService, ({ instanceId }) => safetyFacade(safety, instanceId));
  host.provideScoped(SecretsService, ({ permissions }): PluginSecrets => {
    const check = (name: string) => {
      if (!permissions.has(secretPermission(name)))
        throw new Error(`没有权限 ${secretPermission(name)}`);
    };
    return {
      read: async (name) => {
        check(name);
        return memory.get(name);
      },
      write: async (name, value) => {
        check(name);
        await memory.set(name, value);
      },
      delete: async (name) => {
        check(name);
        return memory.delete(name);
      },
    };
  });
  safety.setModeration(false);
  host.add(entries, catalog(cloudTts, simTts, speechArbiter, stageService, simStagePage));
  await host.settled();
  return {
    kernel: host,
    safety,
    store,
    logs,
    secrets: memory,
    state: (id: string) => host.snapshot().find((e) => e.id === id),
    service<T>(token: ServiceToken<T>): T {
      const found = host.services.resolve(token.name, token.major);
      if ('missing' in found) throw new Error(found.missing);
      return found.impl as T;
    },
    events: (type: string) => store.events().filter((e) => e.type === type),
    async close() {
      await host.shutdown();
      store.close();
    },
  };
}
