/**
 * P1 第 4 步的真机演练：Stage 来源隐藏超过 5 分钟后，心跳丢失时真实页面仍能自静音（P1 任务卡出口“Stage”）。
 *
 *   node spikes/drill-stage-hidden.ts --stage-source 名字 [--scene 场景名] [--hidden-minutes 5.5]
 *
 * 本进程装配安全核、OBS 控制与真实 Stage 页面（宿主一侧），自己扮演 Stage 服务：直接经页面链路发许可令牌、
 * 心跳与音频，因此可以只停心跳、不碰别的。页面经 OBS 控制拿到 URL 并认证后，隐藏浏览器源所在的场景项；
 * 隐藏期间照常发心跳。到时后开始播一句长测试音，播放中停发心跳，记录页面回报 muted 与截断的时间
 * （页面在 AudioWorklet 里按已渲染帧计 1 秒），并核对之后游标不再前进。另记下隐藏期间 OBS 音量表的读数。
 *
 * 会改写浏览器源的 URL 并隐藏它；推流或录制进行中时拒绝运行，结束后恢复 URL 与可见性。
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { OBS_SECRET, readObsSecret } from '@bellis/config';
import { ClockService, catalog, definePlugin, Kernel, systemClock } from '@bellis/kernel';
import { ObsClient, type ObsResult } from '@bellis/obs';
import { SafetyCore, SafetyService, STAGE_URL, safetyFacade } from '@bellis/safety';
import { KeyringSecretStore } from '@bellis/secret-store';
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
import { type MeterReading, ObsMeters } from './s01-stage/meters.ts';

const SAMPLE_RATE = 24_000;
const HEARTBEAT_MS = 250;

function ok(result: ObsResult): Record<string, unknown> {
  if (!result.ok)
    throw new Error(`${result.requestType} 失败：${result.code} ${result.comment ?? ''}`);
  return result.data ?? {};
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function tone(samples: number, offset: number): Int16Array {
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    pcm[i] = Math.round(6553 * Math.sin((2 * Math.PI * 440 * (offset + i)) / SAMPLE_RATE));
  }
  return pcm;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'stage-source': { type: 'string' },
      scene: { type: 'string' },
      'hidden-minutes': { type: 'string', default: '5.5' },
      out: { type: 'string' },
    },
  });
  const stageSource = values['stage-source'];
  if (!stageSource) throw new Error('需要 --stage-source');
  const hiddenMs = Number(values['hidden-minutes']) * 60_000;

  const secret = await readObsSecret(new KeyringSecretStore('bellis'), OBS_SECRET);
  const obs = await ObsClient.connect(secret.url, secret.password);
  const meterLog: Array<{ at: number; db: number }> = [];
  const meters = await ObsMeters.connect(
    secret.url,
    secret.password,
    (readings: MeterReading[]) => {
      const reading = readings.find((r) => r.name === stageSource);
      if (reading) meterLog.push({ at: Date.now(), db: reading.peakDb });
    },
  );
  if (ok(await obs.request('GetStreamStatus')).outputActive)
    throw new Error('推流进行中，拒绝运行');
  if (ok(await obs.request('GetRecordStatus')).outputActive)
    throw new Error('录制进行中，拒绝运行');
  const scene =
    values.scene ??
    (ok(await obs.request('GetCurrentProgramScene')).currentProgramSceneName as string);
  const itemId = ok(
    await obs.request('GetSceneItemId', { sceneName: scene, sourceName: stageSource }),
  ).sceneItemId as number;
  const originalUrl = (
    ok(await obs.request('GetInputSettings', { inputName: stageSource })).inputSettings as Record<
      string,
      unknown
    >
  ).url;

  const path = join(tmpdir(), `bellis-drill-hidden-${randomBytes(4).toString('hex')}.db`);
  const store = StateStore.open({ path });
  const clock = systemClock();
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
      emergency: { stageSource, safeScene: 'Safe', stopStream: false },
      unattendedGatesSatisfied: false,
    },
    obs: { ready: true, run: async () => ({ ok: true, results: [] }) },
    permissionsOf: (holder) => kernel?.permissionsOf(holder),
    watchdogConnected: () => true,
  });
  kernel = new Kernel({ clock, safety: core.kernelHooks() });
  kernel.provideScoped(SafetyService, ({ instanceId }) => safetyFacade(core, instanceId));
  kernel.provideCore(ClockService, clock);
  kernel.provideCore(ObsConnectorService, {
    connect: () => ObsClient.connect(secret.url, secret.password),
  });
  let link: PageLink | undefined;
  const events: Array<{ at: number; event: FromPage }> = [];
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
      ctx.register(link.onMessage((event) => events.push({ at: Date.now(), event })));
    },
  });
  kernel.add(
    [
      {
        id: 'obs',
        plugin: 'obs-control',
        config: {},
        disabled: false,
        explicitSwitch: false,
        grant: ['obs.control'],
      },
      {
        id: 'page',
        plugin: 'stage-page-obs',
        config: {},
        disabled: false,
        explicitSwitch: false,
        grant: [STAGE_URL],
      },
      {
        id: 'driver',
        plugin: 'drill-stage-driver',
        config: {},
        disabled: false,
        explicitSwitch: false,
        grant: [],
      },
    ],
    catalog(obsControl, obsStagePage, driver),
  );
  await kernel.settled();

  let beating = true;
  const beat = setInterval(() => {
    if (beating && link?.ready) link.send({ kind: 'heartbeat' });
  }, HEARTBEAT_MS);
  const started = new Date().toISOString();
  let result: Record<string, unknown> = {};
  try {
    const deadline = Date.now() + 30_000;
    while (!link?.ready) {
      if (Date.now() > deadline) throw new Error('页面未在 30 秒内认证');
      await sleep(100);
    }
    const page = link;
    page.send({ kind: 'token', token: 1, ttlMs: 3_600_000 });

    ok(
      await obs.request('SetSceneItemEnabled', {
        sceneName: scene,
        sceneItemId: itemId,
        sceneItemEnabled: false,
      }),
    );
    const hiddenAt = Date.now();
    console.log(`已隐藏「${stageSource}」，${hiddenMs / 60_000} 分钟后开始播放并停发心跳`);
    await sleep(hiddenMs);

    // 一句 20 秒的测试音，前 6 秒按实时节奏送，然后停发心跳、继续送音频。
    const sentenceId = 'hidden-1';
    page.send({
      kind: 'begin',
      sentenceId,
      token: 1,
      subtitle: '隐藏测试',
      sampleRate: SAMPLE_RATE,
    });
    const chunk = SAMPLE_RATE / 10;
    let offset = 0;
    const send = () => {
      page.send({ kind: 'audio', sentenceId, token: 1, pcm: tone(chunk, offset) });
      offset += chunk;
    };
    for (let i = 0; i < 5; i++) send();
    for (let i = 0; i < 60; i++) {
      send();
      await sleep(100);
    }
    const startedEvent = events.find((e) => e.event.kind === 'started');
    beating = false;
    const stoppedAt = Date.now();
    const playedBefore = [...events].reverse().find((e) => e.event.kind === 'cursor');
    for (let i = 0; i < 40; i++) {
      send();
      await sleep(100);
    }
    const muted = events.find((e) => e.event.kind === 'muted' && e.at >= stoppedAt);
    const truncated = events.find((e) => e.event.kind === 'truncated' && e.at >= stoppedAt);
    const cursorsAfterMute = muted
      ? events.filter((e) => e.event.kind === 'cursor' && e.at > muted.at + 200).length
      : null;
    const loud = (from: number, to: number) =>
      meterLog.filter((m) => m.at >= from && m.at < to && m.db > -40).length;
    result = {
      hiddenMinutes: (stoppedAt - hiddenAt) / 60_000,
      started: Boolean(startedEvent),
      lastCursorBeforeStop: playedBefore?.event,
      mutedAfterMs: muted ? muted.at - stoppedAt : null,
      truncated: truncated?.event ?? null,
      cursorsAfterMute,
      meterLoudReadingsWhilePlayingHidden: loud(startedEvent?.at ?? stoppedAt, stoppedAt),
      meterLoudReadingsAfterMute: muted ? loud(muted.at + 200, Date.now()) : null,
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    clearInterval(beat);
    await obs.request('SetSceneItemEnabled', {
      sceneName: scene,
      sceneItemId: itemId,
      sceneItemEnabled: true,
    });
    await kernel.shutdown();
    await obs.request('SetInputSettings', {
      inputName: stageSource,
      inputSettings: { url: originalUrl ?? '' },
      overlay: true,
    });
    meters.close();
    obs.close();
    store.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  }
  const out = resolve(
    values.out ?? join('reports', `drill-stage-hidden-${started.slice(0, 10)}.json`),
  );
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    `${JSON.stringify({ drill: 'stage-hidden', started, finished: new Date().toISOString(), stageSource, scene, ...result }, null, 2)}\n`,
  );
  console.log(`结果已写入 ${out}`);
}

await main();
