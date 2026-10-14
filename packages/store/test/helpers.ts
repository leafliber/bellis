import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IntentInput, Projection, StoredEvent } from '../src/index.ts';

export function tempDb(): { path: string; cleanup(): void } {
  const path = join(tmpdir(), `bellis-store-${randomBytes(6).toString('hex')}.db`);
  return {
    path,
    cleanup() {
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    },
  };
}

/** 按事件类型计数的投影。 */
export const counts: Projection<Record<string, number>> = {
  name: 'counts',
  initial: {},
  reduce: (state, event: StoredEvent) => ({ ...state, [event.type]: (state[event.type] ?? 0) + 1 }),
};

export function fold<S>(projection: Projection<S>, events: readonly StoredEvent[]): S {
  return events.reduce((state, event) => projection.reduce(state, event), projection.initial);
}

export function intent(key: string, overrides: Partial<IntentInput> = {}): IntentInput {
  return {
    key,
    type: 'speech.play',
    target: 'stage',
    payloadHash: `hash-${key}`,
    source: { origin: 'test', inputs: [], untrusted: false },
    capabilities: ['speech.output'],
    timeSensitive: true,
    ...overrides,
  };
}

export function counter(): () => number {
  let t = 1_000;
  return () => (t += 1);
}
