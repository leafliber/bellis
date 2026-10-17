/**
 * Stage 诊断用的进程内装配（做法同 drill-stage-hidden）：安全核、OBS 控制与真实 Stage 页面的宿主一侧都在本进程，
 * 本进程扮演 Stage 服务，直接经页面链路发心跳、许可令牌与句子，逐条记下页面的回报与到达时刻；
 * 心跳应答因此能逐条计时，这是真实宿主的日志里看不到的。页面本身就是 OBS 浏览器源里的真实 Stage 页面。
 * 安全核的 OBS 应急连接是桩（不做任何 OBS 动作）；OBS 控制用 SecretStore 中的 obs 凭据连接，只写 Stage URL。
 */
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClockService, catalog, definePlugin, Kernel, systemClock } from '@bellis/kernel';
import { ObsClient } from '@bellis/obs';
import { SafetyCore, SafetyService, STAGE_URL, safetyFacade } from '@bellis/safety';
import {
  type FromPage,
  OBS_CONTROL,
  ObsConnectorService,
  obsControl,
  obsStagePage,
  type PageLink,
  StagePageService,
} from '@bellis/stage';
import { StateStore } from '@bellis/store';
import Type from 'typebox';

export const HARNESS_SAMPLE_RATE = 24_000;
const FRAME_SAMPLES = 480;
const TOKEN = 1;

export interface PageEventAt {
  at: number;
  event: FromPage;
}

export interface HarnessOptions {
  url: string;
  password: string | undefined;
  stageSource: string;
  heartbeatMs?: number;
}

/** 0.2 振幅、从相位 0 开始的 440Hz 正弦，与模拟 TTS 的测试音相同。 */
export function tone(samples: number): Int16Array {
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++)
    pcm[i] = Math.round(6553 * Math.sin((2 * Math.PI * 440 * i) / HARNESS_SAMPLE_RATE));
  return pcm;
}

export async function startStageHarness(options: HarnessOptions) {
  const heartbeatMs = options.heartbeatMs ?? 250;
  const path = join(tmpdir(), `bellis-stage-harness-${randomBytes(4).toString('hex')}.db`);
  const store = StateStore.open({ path });
  const clock = systemClock();
  const logs: Array<{ at: number; event: string; fields: Record<string, unknown> }> = [];
  let kernel: Kernel | undefined;
  const core = new SafetyCore({
    store,
    clock,
    config: {
      simulation: false,
      leaseTtlMs: { [OBS_CONTROL]: 2000, [STAGE_URL]: 2000 },
      leaseCapabilities: { [OBS_CONTROL]: 'obs.control', [STAGE_URL]: 'obs.control' },
      presenceTtlMs: 60_000,
      rateLimits: {},
      guardTimeoutMs: 200,
      emergency: { stageSource: options.stageSource, safeScene: 'Safe', stopStream: false },
      unattendedGatesSatisfied: false,
    },
    obs: { ready: true, run: async () => ({ ok: true, results: [] }) },
    permissionsOf: (holder) => kernel?.permissionsOf(holder),
    watchdogConnected: () => true,
  });
  kernel = new Kernel({
    clock,
    safety: core.kernelHooks(),
    log: (event, fields = {}) => logs.push({ at: Date.now(), event, fields }),
  });
  kernel.provideScoped(SafetyService, ({ instanceId }) => safetyFacade(core, instanceId));
  kernel.provideCore(ClockService, clock);
  kernel.provideCore(ObsConnectorService, {
    connect: () => ObsClient.connect(options.url, options.password),
  });
  let link: PageLink | undefined;
  const events: PageEventAt[] = [];
  const waiters = new Set<() => void>();
  const driver = definePlugin({
    manifest: {
      id: 'drill-stage-driver',
      version: '1.0.0',
      tier: 'ordinary',
      provides: [],
      inject: [StagePageService.ref],
      permissions: [],
      process: 'in-process',
      config: Type.Object({}),
    },
    activate(ctx) {
      link = ctx.service(StagePageService);
      ctx.register(
        link.onMessage((event) => {
          events.push({ at: Date.now(), event });
          for (const wake of waiters) wake();
        }),
      );
    },
  });
  const entry = (id: string, plugin: string, grant: string[]) => ({
    id,
    plugin,
    config: {},
    disabled: false,
    explicitSwitch: false,
    grant,
  });
  kernel.add(
    [
      entry('obs', 'obs-control', ['obs.control']),
      entry('page', 'stage-page-obs', [STAGE_URL]),
      entry('driver', 'drill-stage-driver', []),
    ],
    catalog(obsControl, obsStagePage, driver),
  );
  await kernel.settled();
  const active = kernel;

  const heartbeats: number[] = [];
  let beating = true;
  const beat = setInterval(() => {
    if (beating && link?.ready) {
      heartbeats.push(Date.now());
      link.send({ kind: 'heartbeat' });
    }
  }, heartbeatMs);
  let tokenSent = false;
  let sentences = 0;

  const page = () => {
    if (!link) throw new Error('页面链路不在');
    return link;
  };

  /** 等到页面回报满足条件（只看 from 之后的回报）。 */
  const waitEvent = async (
    match: (event: FromPage) => boolean,
    timeoutMs: number,
    from = 0,
  ): Promise<PageEventAt> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = events.slice(from).find((e) => match(e.event));
      if (found) return found;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('页面回报未在时限内到达');
      await new Promise<void>((wake) => {
        const done = () => {
          waiters.delete(done);
          wake();
        };
        waiters.add(done);
        setTimeout(done, Math.min(left, 100));
      });
    }
  };

  return {
    events,
    logs,
    heartbeats,
    get ready() {
      return link?.ready === true;
    },
    async waitReady(timeoutMs: number) {
      const deadline = Date.now() + timeoutMs;
      while (!link?.ready) {
        if (Date.now() > deadline) throw new Error('页面未在时限内认证');
        await new Promise((wait) => setTimeout(wait, 100));
      }
    },
    setBeating(on: boolean) {
      beating = on;
    },
    /** 心跳应答的到达时刻。 */
    acks() {
      return events.filter((e) => e.event.kind === 'heartbeat-ack').map((e) => e.at);
    },
    waitEvent,
    /**
     * 播一句测试音：一次送完全部音频，等页面回报播完或截断。返回发出时刻与页面的 started、结束回报。
     */
    async play(seconds: number) {
      const link = page();
      if (!tokenSent) {
        link.send({ kind: 'token', token: TOKEN, ttlMs: 3_600_000 });
        tokenSent = true;
      }
      sentences += 1;
      const sentenceId = `harness-${sentences}`;
      const from = events.length;
      const pcm = tone(Math.round(seconds * HARNESS_SAMPLE_RATE));
      const sentAt = Date.now();
      link.send({
        kind: 'begin',
        sentenceId,
        token: TOKEN,
        subtitle: '诊断用测试音',
        sampleRate: HARNESS_SAMPLE_RATE,
      });
      for (let offset = 0; offset < pcm.length; offset += FRAME_SAMPLES) {
        link.send({
          kind: 'audio',
          sentenceId,
          token: TOKEN,
          pcm: pcm.subarray(offset, offset + FRAME_SAMPLES),
        });
      }
      link.send({ kind: 'end', sentenceId, token: TOKEN });
      const isThis = (e: FromPage) => 'sentenceId' in e && e.sentenceId === sentenceId;
      const finished = await waitEvent(
        (e) => isThis(e) && (e.kind === 'ended' || e.kind === 'truncated'),
        seconds * 1000 + 10_000,
        from,
      );
      const started = events.slice(from).find((e) => isThis(e.event) && e.event.kind === 'started');
      return {
        sentenceId,
        samples: pcm.length,
        sentAt,
        startedAt: started?.at ?? null,
        finishedAt: finished.at,
        finished: finished.event,
      };
    },
    /**
     * 播一句中途断流的测试音（模拟 TTS 中途卡住）：先送前一半，等页面回报欠载，再停 pauseSeconds 秒，
     * 然后送后一半。测试音按绝对采样位置生成，前一半为 0.75 秒时后一半恰从相位 0 起。
     */
    async playSplit(seconds: number, pauseSeconds: number) {
      const link = page();
      if (!tokenSent) {
        link.send({ kind: 'token', token: TOKEN, ttlMs: 3_600_000 });
        tokenSent = true;
      }
      sentences += 1;
      const sentenceId = `harness-${sentences}`;
      const from = events.length;
      const pcm = tone(Math.round(seconds * HARNESS_SAMPLE_RATE));
      const half = Math.round(pcm.length / 2);
      const send = (part: Int16Array) => {
        for (let offset = 0; offset < part.length; offset += FRAME_SAMPLES)
          link.send({
            kind: 'audio',
            sentenceId,
            token: TOKEN,
            pcm: part.subarray(offset, offset + FRAME_SAMPLES),
          });
      };
      const isThis = (e: FromPage) => 'sentenceId' in e && e.sentenceId === sentenceId;
      const sentAt = Date.now();
      link.send({
        kind: 'begin',
        sentenceId,
        token: TOKEN,
        subtitle: '诊断用测试音',
        sampleRate: HARNESS_SAMPLE_RATE,
      });
      send(pcm.subarray(0, half));
      const underrun = await waitEvent(
        (e) => isThis(e) && e.kind === 'underrun',
        seconds * 1000 + 10_000,
        from,
      );
      await new Promise((wait) => setTimeout(wait, pauseSeconds * 1000));
      const resumedAt = Date.now();
      send(pcm.subarray(half));
      link.send({ kind: 'end', sentenceId, token: TOKEN });
      const finished = await waitEvent(
        (e) => isThis(e) && (e.kind === 'ended' || e.kind === 'truncated'),
        seconds * 1000 + 10_000,
        from,
      );
      const started = events.slice(from).find((e) => isThis(e.event) && e.event.kind === 'started');
      return {
        sentenceId,
        samples: pcm.length,
        sentAt,
        startedAt: started?.at ?? null,
        underrunAt: underrun.at,
        resumedAt,
        finishedAt: finished.at,
        finished: finished.event,
      };
    },
    async close() {
      clearInterval(beat);
      await active.shutdown();
      store.close();
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    },
  };
}

export type StageHarness = Awaited<ReturnType<typeof startStageHarness>>;
