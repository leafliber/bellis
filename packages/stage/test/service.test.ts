import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Clock,
  ClockService,
  catalog,
  definePlugin,
  Kernel,
  type TimerHandle,
} from '@bellis/kernel';
import { SafetyCore, SafetyService, safetyFacade } from '@bellis/safety';
import { StateStore } from '@bellis/store';
import Type from 'typebox';
import { type FromPage, StagePageService, stageService, type ToPage } from '../src/index.ts';

/**
 * 可控时钟：advance 按到期时刻准点触发定时器；jump 让时间一下跳过去，期间到期的定时器都在跳到的那一刻
 * 才触发，模拟宿主卡住（事件循环阻塞或进程被挂起）之后恢复。
 */
class StepClock implements Clock {
  #now = 0;
  #next = 1;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, ms: number): TimerHandle {
    const id = this.#next++;
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), callback });
    return { id };
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle.id);
  }

  #fire(until: number, late: boolean): void {
    for (;;) {
      let pick: [number, { at: number; callback: () => void }] | undefined;
      for (const entry of this.#timers) {
        if (entry[1].at <= until && (!pick || entry[1].at < pick[1].at)) pick = entry;
      }
      if (!pick) return;
      this.#timers.delete(pick[0]);
      if (!late) this.#now = pick[1].at;
      pick[1].callback();
    }
  }

  advance(ms: number): void {
    const target = this.#now + ms;
    this.#fire(target, false);
    this.#now = target;
  }

  jump(ms: number): void {
    this.#now += ms;
    this.#fire(this.#now, true);
  }
}

async function setup() {
  const clock = new StepClock();
  const store = StateStore.open({ path: ':memory:' });
  const logs: Array<{ at: number; event: string; fields: Record<string, unknown> }> = [];
  const log = (event: string, fields: Record<string, unknown> = {}) =>
    logs.push({ at: clock.now(), event, fields });
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
  });
  // 已认证的页面：收到心跳即应答（answering 关掉时不应答）。
  const page = { answering: true, heartbeats: [] as number[] };
  const listeners = new Set<(message: FromPage) => void>();
  const fakePage = definePlugin({
    manifest: {
      id: 'fake-page',
      version: '1.0.0',
      tier: 'critical',
      provides: [StagePageService.ref],
      inject: [],
      permissions: [],
      process: 'in-process',
      config: Type.Object({}),
    },
    activate(ctx) {
      ctx.provide(StagePageService, {
        ready: true,
        send(message: ToPage) {
          if (message.kind !== 'heartbeat') return;
          page.heartbeats.push(clock.now());
          if (page.answering) for (const listener of listeners) listener({ kind: 'heartbeat-ack' });
        },
        onMessage(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      });
    },
  });
  kernel = new Kernel({ clock, safety: core.kernelHooks(), log });
  kernel.provideScoped(SafetyService, ({ instanceId }) => safetyFacade(core, instanceId));
  kernel.provideCore(ClockService, clock);
  const entry = (id: string, plugin: string) => ({
    id,
    plugin,
    config: plugin === 'stage-service' ? { heartbeatMs: 250, pageTimeoutMs: 1000 } : {},
    disabled: false,
    explicitSwitch: false,
    grant: [],
  });
  kernel.add(
    [entry('page', 'fake-page'), entry('stage', 'stage-service')],
    catalog(fakePage, stageService),
  );
  await kernel.settled();
  const active = kernel;
  return {
    clock,
    page,
    logs,
    failures: () => logs.filter((l) => l.event === 'plugin.failed' && l.fields.entry === 'stage'),
    late: () => logs.filter((l) => l.event === 'stage.heartbeat-late'),
    async close() {
      await active.shutdown();
      store.close();
    },
  };
}

test('页面不再应答心跳：超过页面超时即判 Stage 页面无响应', async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 8; i++) s.clock.advance(250);
    assert.equal(s.failures().length, 0);
    s.page.answering = false;
    const stoppedAt = s.clock.now();
    for (let i = 0; i < 6; i++) s.clock.advance(250);
    const [failure] = s.failures();
    assert.equal(failure?.fields.error, 'Stage 页面无响应');
    assert.ok((failure?.at ?? 0) - stoppedAt > 1000);
    assert.equal(s.late().length, 0);
  } finally {
    await s.close();
  }
});

test('宿主卡住后心跳定时器晚到：这一轮不判页面失败，先发心跳、重新计时，并记日志', async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 4; i++) s.clock.advance(250);
    const before = s.page.heartbeats.length;
    // 宿主卡住 1.5 秒：期间不发心跳，页面也就没有应答；恢复后定时器晚到 1250ms。
    s.clock.jump(1500);
    assert.equal(s.failures().length, 0);
    assert.equal(s.page.heartbeats.length, before + 1, '恢复后立即补发心跳');
    const [late] = s.late();
    assert.equal(late?.fields.lateMs, 1250);
    assert.equal(late?.fields.sinceAckMs, 1500);
    for (let i = 0; i < 8; i++) s.clock.advance(250);
    assert.equal(s.failures().length, 0);
    // 晚到不足一个周期：照常判定，不记日志。
    s.clock.jump(450);
    assert.equal(s.late().length, 1);
    assert.equal(s.failures().length, 0);
  } finally {
    await s.close();
  }
});

test('卡住期间页面也真的停了：恢复后重新计时，再过一个页面超时照样判失败', async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 4; i++) s.clock.advance(250);
    s.page.answering = false;
    s.clock.jump(1500);
    const resumedAt = s.clock.now();
    assert.equal(s.failures().length, 0);
    for (let i = 0; i < 6; i++) s.clock.advance(250);
    const [failure] = s.failures();
    assert.equal(failure?.fields.error, 'Stage 页面无响应');
    const after = (failure?.at ?? 0) - resumedAt;
    assert.ok(after > 1000 && after <= 1250, `恢复后 ${after}ms 判失败`);
  } finally {
    await s.close();
  }
});
