import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManualClock } from '@bellis/kernel';
import { SimObs } from '@bellis/obs';
import { StateStore } from '@bellis/store';
import {
  type IntentRequest,
  ObsEmergencyConnection,
  type SafetyConfig,
  SafetyCore,
} from '../src/index.ts';

export const defaults: SafetyConfig = {
  simulation: false,
  leaseTtlMs: { 'stage.audio': 2000, 'game.input': 500 },
  leaseCapabilities: { 'stage.audio': 'speech.output', 'game.input': 'game.input' },
  presenceTtlMs: 60_000,
  rateLimits: { 'speech.output': { max: 3, windowMs: 10_000 } },
  guardTimeoutMs: 200,
  emergency: { stageSource: 'Stage', safeScene: 'Safe', stopStream: false },
  unattendedGatesSatisfied: true,
};

export async function setup(
  config: Partial<SafetyConfig> = {},
  options: { fault?: (point: string) => void } = {},
) {
  const path = join(tmpdir(), `bellis-safety-${randomBytes(6).toString('hex')}.db`);
  const store = StateStore.open({ path, ...(options.fault ? { fault: options.fault } : {}) });
  const clock = new ManualClock();
  const obs = await SimObs.start();
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const log = (event: string, fields: Record<string, unknown>) => logs.push({ event, fields });
  const emergency = new ObsEmergencyConnection({ url: obs.url }, clock, log);
  await emergency.start();
  const permissions = new Map<string, ReadonlySet<string>>([
    ['speaker#1', new Set(['speech.output'])],
    ['other#2', new Set(['speech.output'])],
    ['director#3', new Set(['speech.output', 'obs.scene'])],
  ]);
  const world = { watchdog: true };
  const safety = new SafetyCore({
    store,
    clock,
    config: { ...defaults, ...config },
    obs: emergency,
    permissionsOf: (holder) => permissions.get(holder),
    watchdogConnected: () => world.watchdog,
    log,
  });
  return {
    safety,
    store,
    clock,
    obs,
    logs,
    world,
    events: (type: string) => store.events().filter((e) => e.type === type),
    async close() {
      emergency.close();
      store.close();
      await obs.close();
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    },
  };
}

let next = 0;
export function request(overrides: Partial<IntentRequest> = {}): IntentRequest {
  next += 1;
  return {
    holder: 'speaker#1',
    key: `k${next}`,
    type: 'speech.play',
    target: 'stage',
    payload: { text: `第 ${next} 句` },
    source: { origin: 'director', inputs: [], untrusted: false },
    capabilities: ['speech.output'],
    timeSensitive: true,
    ...overrides,
  };
}

/** 让已经排队的微任务与 I/O 回调跑完。 */
export const flush = () => new Promise((resolve) => setImmediate(resolve));
