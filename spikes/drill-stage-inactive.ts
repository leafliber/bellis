/**
 * P1 第 10 步的真机诊断：节目场景切到安全场景后，Stage 页面过一阵就不再应答心跳，
 * 关键平面的 Stage 服务以“Stage 页面无响应”反复失败、重启。
 *
 *   node spikes/drill-stage-inactive.ts --stage-source 名字 [--safe-scene Safe] [--seconds 120]
 *                                        [--hidden-seconds 60] [--host] [--out 结果文件前缀]
 *
 * 第一部分：本进程装配真实页面（spikes/stage-harness.ts），逐条计时心跳应答（每 250ms 一次心跳）：
 *   1. 留在原场景 15 秒，作基线；
 *   2. 对照：留在原场景、隐藏 Stage 源的场景项 --hidden-seconds 秒，再显示；
 *   3. 节目场景切到安全场景（Stage 源所在场景不在节目里），持续 --seconds 秒；
 *   4. 切回原场景观察 30 秒，并播一句测试音，核对页面照常播放。
 *   每段记下应答间隔的分布、超过 500ms 与 1000ms（Stage 服务的缺省超时）的间隔各从第几秒开始、有多长，
 *   以及页面会话的断开、重连（stage-page-obs 的日志）。
 * 第二部分（--host）：真实宿主与看门狗。操作员急停（宿主经 OBS 应急连接切安全场景并静音），观察 --seconds 秒
 *   里 Stage 服务的失败与重启；然后像操作员那样把节目场景切回原场景并取消静音，再观察 30 秒，确认在场后切 M2
 *   播一句，核对恢复播出，最后急停。
 *   --freeze-ms 600,900,…：改为挂起整个宿主进程这么多毫秒（NtSuspendProcess，同 drill-safety），恢复后观察
 *   8 秒里 Stage 服务是否失败、看门狗是否动作；每次之后切回原场景、取消静音，等 Stage 服务恢复。
 *
 * 只改写浏览器源的 URL、切换节目场景、隐藏与显示场景项、静音；推流或录制进行中、或有别的 Bellis 进程在运行时
 * 拒绝运行；结束时整体恢复并读回比对。
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { connect, decodeSessionKey, RpcPeer } from '@bellis/channel';
import { loadConfig, OBS_SECRET, readObsSecret, writeObsSecret } from '@bellis/config';
import { launch, type Session } from '@bellis/launcher';
import { ObsClient, type ObsResult } from '@bellis/obs';
import { OperatorMethod, Role } from '@bellis/protocol';
import { KeyringSecretStore, SESSION_SECRET } from '@bellis/secret-store';
import { waitForNoOtherBellis } from './bellis-processes.ts';
import { differences, restoreSnapshot, snapshot } from './obs-snapshot.ts';
import { type MeterReading, ObsMeters } from './s01-stage/meters.ts';
import { type StageHarness, startStageHarness } from './stage-harness.ts';

const file = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const hostMain = file('../packages/host/src/main.ts');
const watchdogMain = file('../packages/watchdog/src/main.ts');
const liveExample = file('../config/live.example.json');
const SOUND_DB = -40;
const TEXT = '这是一句用来核对安全场景之后恢复播出的测试播报。';
/** 常驻的 PowerShell：按行读入 suspend <pid> / resume <pid>，挂起或恢复整个进程后回一行（同 drill-safety）。 */
const SUSPENDER = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Drill -Name Nt -MemberDefinition '[System.Runtime.InteropServices.DllImport("ntdll.dll")] public static extern int NtSuspendProcess(System.IntPtr handle); [System.Runtime.InteropServices.DllImport("ntdll.dll")] public static extern int NtResumeProcess(System.IntPtr handle);'
[Console]::Out.WriteLine('ready')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $verb, $id = $line.Split(' ')
  $p = [System.Diagnostics.Process]::GetProcessById([int]$id)
  if ($verb -eq 'suspend') { $r = [Drill.Nt]::NtSuspendProcess($p.Handle) } else { $r = [Drill.Nt]::NtResumeProcess($p.Handle) }
  [Console]::Out.WriteLine("$verb $r")
}
`;

type LogLine = { t: string; event: string; [field: string]: unknown };

class Lines {
  readonly items: LogLine[] = [];
  readonly #waiters = new Set<() => void>();

  constructor(stream: Readable | null, raw = false) {
    if (!stream) throw new Error('没有可读的输出');
    createInterface({ input: stream }).on('line', (line) => {
      if (raw) {
        this.items.push({ t: new Date().toISOString(), event: line });
        for (const wake of this.#waiters) wake();
        return;
      }
      try {
        this.items.push(JSON.parse(line) as LogLine);
      } catch {
        return;
      }
      for (const wake of this.#waiters) wake();
    });
  }

  async wait(match: (line: LogLine) => boolean, timeoutMs: number, from = 0): Promise<LogLine> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.items.slice(from).find(match);
      if (found) return found;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`等待超时：${JSON.stringify(this.items.slice(-5))}`);
      await new Promise<void>((wake) => {
        const done = () => {
          this.#waiters.delete(done);
          wake();
        };
        this.#waiters.add(done);
        setTimeout(done, Math.min(left, 100));
      });
    }
  }
}

function ok(result: ObsResult): Record<string, unknown> {
  if (!result.ok)
    throw new Error(`${result.requestType} 失败：${result.code} ${result.comment ?? ''}`);
  return result.data ?? {};
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

function summarize(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    n: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted.at(-1) ?? 0),
  };
}

/** 一段时间里心跳应答的统计（时刻都相对这段的开头，秒）。 */
function ackStats(harness: StageHarness, from: number, to: number) {
  const acks = harness.acks().filter((t) => t >= from && t < to);
  const sent = harness.heartbeats.filter((t) => t >= from && t < to).length;
  const gaps: Array<{ atS: number; ms: number }> = [];
  let previous = from;
  for (const t of [...acks, to]) {
    gaps.push({ atS: round((previous - from) / 1000, 2), ms: t - previous });
    previous = t;
  }
  const long = (ms: number) => gaps.filter((g) => g.ms > ms);
  // 每 5 秒一格的应答数，看衰减的过程。
  const perFive: number[] = [];
  for (let t = from; t < to; t += 5000)
    perFive.push(acks.filter((a) => a >= t && a < t + 5000).length);
  return {
    seconds: round((to - from) / 1000),
    heartbeatsSent: sent,
    acks: acks.length,
    gapMs: summarize(gaps.map((g) => g.ms)),
    over500: {
      count: long(500).length,
      firstAtS: long(500)[0]?.atS ?? null,
      listed: long(500).slice(0, 50),
    },
    over1000: { count: long(1000).length, firstAtS: long(1000)[0]?.atS ?? null },
    acksPerFiveSeconds: perFive,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'stage-source': { type: 'string' },
      'safe-scene': { type: 'string', default: 'Safe' },
      seconds: { type: 'string', default: '120' },
      'hidden-seconds': { type: 'string', default: '60' },
      host: { type: 'boolean', default: false },
      'skip-harness': { type: 'boolean', default: false },
      'freeze-ms': { type: 'string' },
      out: { type: 'string' },
    },
  });
  const stageSource = values['stage-source'];
  if (!stageSource) throw new Error('需要 --stage-source');
  const safeScene = values['safe-scene'];
  const inactiveMs = Number(values.seconds) * 1000;
  const hiddenMs = Number(values['hidden-seconds']) * 1000;
  const freezes = values['freeze-ms'] ? values['freeze-ms'].split(',').map(Number) : [];
  const started = new Date().toISOString();
  const out = resolve(
    values.out ?? join('reports', `drill-stage-inactive-${started.replace(/[:.]/g, '-')}`),
  );
  const say = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

  await waitForNoOtherBellis({ log: say });
  const secret = await readObsSecret(new KeyringSecretStore('bellis'), OBS_SECRET);
  const obs = await ObsClient.connect(secret.url, secret.password);
  const loud: number[] = [];
  /** Stage 源的音量表读数是否出现（来源不 active 时 OBS 不为它报音量）。 */
  const meterSeen: number[] = [];
  const meters = await ObsMeters.connect(
    secret.url,
    secret.password,
    (readings: MeterReading[]) => {
      const reading = readings.find((r) => r.name === stageSource);
      if (reading) meterSeen.push(Date.now());
      if (reading && reading.peakDb > SOUND_DB) loud.push(Date.now());
    },
  );
  const original = await snapshot(obs, stageSource, safeScene);
  const scene = original.programScene;
  const result: Record<string, unknown> = { scene, safeScene };
  let harness: StageHarness | undefined;
  let session: Session | undefined;
  const service = `bellis-drill-${randomBytes(4).toString('hex')}`;
  const store = new KeyringSecretStore(service);
  const configPath = join(tmpdir(), `${service}.json`);
  const profilePath = join(tmpdir(), `${service}.profile.json`);
  const storePath = join(tmpdir(), `${service}.db`);
  try {
    if (ok(await obs.request('GetStreamStatus')).outputActive)
      throw new Error('推流进行中，拒绝运行');
    if (ok(await obs.request('GetRecordStatus')).outputActive)
      throw new Error('录制进行中，拒绝运行');
    if (scene === safeScene) throw new Error('节目场景已经是安全场景');
    const itemId = ok(
      await obs.request('GetSceneItemId', { sceneName: scene, sourceName: stageSource }),
    ).sceneItemId as number;
    ok(await obs.request('SetInputMute', { inputName: stageSource, inputMuted: false }));

    // ---------------- 第一部分：进程内逐条计时 ----------------
    if (!values['skip-harness']) {
      harness = await startStageHarness({
        url: secret.url,
        password: secret.password,
        stageSource,
      });
      await harness.waitReady(30_000);
      const h = harness;
      const phase = async (name: string, ms: number, enter?: () => Promise<void>) => {
        if (enter) await enter();
        const from = Date.now();
        const logsFrom = h.logs.length;
        const eventsFrom = h.events.length;
        say(`开始：${name}（${ms / 1000} 秒）`);
        await sleep(ms);
        const to = Date.now();
        return {
          name,
          ...ackStats(h, from, to),
          meterReadings: meterSeen.filter((t) => t >= from && t < to).length,
          pageLogs: h.logs.slice(logsFrom).map((l) => ({
            s: round((l.at - from) / 1000, 2),
            event: l.event,
            reason: l.fields.reason ?? null,
          })),
          pageEvents: h.events
            .slice(eventsFrom)
            .filter((e) => e.event.kind !== 'heartbeat-ack')
            .map((e) => ({ s: round((e.at - from) / 1000, 2), ...e.event })),
        };
      };
      const phases: Array<Record<string, unknown>> = [];
      phases.push(await phase('原场景（基线）', 15_000));
      phases.push(
        await phase('原场景里隐藏 Stage 源的场景项', hiddenMs, async () => {
          ok(
            await obs.request('SetSceneItemEnabled', {
              sceneName: scene,
              sceneItemId: itemId,
              sceneItemEnabled: false,
            }),
          );
        }),
      );
      phases.push(
        await phase('显示场景项后', 15_000, async () => {
          ok(
            await obs.request('SetSceneItemEnabled', {
              sceneName: scene,
              sceneItemId: itemId,
              sceneItemEnabled: true,
            }),
          );
        }),
      );
      phases.push(
        await phase('节目场景切到安全场景', inactiveMs, async () => {
          ok(await obs.request('SetCurrentProgramScene', { sceneName: safeScene }));
        }),
      );
      phases.push(
        await phase('切回原场景', 30_000, async () => {
          ok(await obs.request('SetCurrentProgramScene', { sceneName: scene }));
        }),
      );
      const playedAt = Date.now();
      const played = await h.play(3);
      result.playbackAfterReturn = {
        finished: played.finished,
        startedAfterSendMs: played.startedAt === null ? null : played.startedAt - played.sentAt,
        loudReadings: loud.filter((t) => t >= playedAt && t <= played.finishedAt).length,
      };
      result.harness = phases;
      say(
        `第一部分：${JSON.stringify(phases.map((p) => ({ name: p.name, over1000: p.over1000, acks: p.acks })))}`,
      );
      await h.close();
      harness = undefined;
    }

    // ---------------- 第二部分：真实宿主 ----------------
    if (values.host) {
      await waitForNoOtherBellis({ log: say });
      await writeObsSecret(store, secret, OBS_SECRET);
      const announcements = Array.from({ length: 100 }, (_, i) => ({
        id: `a${i}`,
        atMs: 4000 + i * 6000,
        text: TEXT,
      }));
      writeFileSync(
        profilePath,
        JSON.stringify({
          name: 'drill-stage-inactive',
          packs: [
            {
              name: 'all',
              entries: [
                { id: 'obs', plugin: 'obs-control', grant: ['obs.control'] },
                { id: 'stage-page', plugin: 'stage-page-obs', grant: ['obs.stage-url'] },
                { id: 'stage', plugin: 'stage-service' },
                {
                  id: 'tts',
                  plugin: 'tts-sim',
                  config: {
                    sampleRate: 24_000,
                    samplesPerChar: 3600,
                    frameSamples: 480,
                    toneHz: 440,
                  },
                },
                { id: 'speech', plugin: 'speech-arbiter', grant: ['speech.output'] },
                {
                  id: 'schedule',
                  plugin: 'speech-schedule',
                  config: { announcements, ttlMs: 20_000 },
                },
                { id: 'moderation', plugin: 'moderation', disabled: true },
              ],
            },
          ],
        }),
      );
      const config = JSON.parse(JSON.stringify(loadConfig(liveExample)));
      config.profile = profilePath;
      config.safety.emergency = { stageSource, safeScene, stopStream: false };
      config.storePath = storePath;
      writeFileSync(configPath, JSON.stringify(config));
      session = await launch({
        configPath,
        secretService: service,
        host: { command: process.execPath, args: [hostMain] },
        watchdog: { command: process.execPath, args: [watchdogMain] },
        stdout: 'pipe',
      });
      const host = new Lines(session.host.stdout);
      const watchdog = new Lines(session.watchdog.stdout);
      const key = decodeSessionKey(session.info.channelKey);
      const operator = new RpcPeer(
        await connect(session.info.channelPath, Role.Operator, { key }),
        {
          timeoutMs: 10_000,
        },
      );
      const call = (method: string, params: Record<string, unknown> = {}) =>
        operator.request(method, params) as Promise<Record<string, unknown>>;
      await host.wait((l) => l.event === 'stage-page.authenticated', 30_000);
      await sleep(3000);
      const stageEvents = (from: number, t0: number) =>
        host.items
          .slice(from)
          .filter(
            (l) =>
              (l.event === 'plugin.failed' && l.entry === 'stage') ||
              (l.event === 'plugin.transition' && l.entryId === 'stage') ||
              String(l.event).startsWith('stage-page.') ||
              l.event === 'stage.muted' ||
              l.event === 'stage.heartbeat-late',
          )
          .map((l) => ({
            s: round((Date.parse(l.t) - t0) / 1000, 2),
            event: l.event,
            ...(l.error ? { error: l.error } : {}),
            ...(l.to ? { to: l.to, reason: l.reason ?? null } : {}),
            ...(l.event.startsWith('stage-page.') && l.reason ? { reason: l.reason } : {}),
            ...(l.lateMs !== undefined ? { lateMs: l.lateMs, sinceAckMs: l.sinceAckMs } : {}),
          }));
      const status = async () =>
        (
          (await call(OperatorMethod.Status)).plugins as Array<{
            id: string;
            state: string;
            reason: string | null;
          }>
        ).find((p) => p.id === 'stage');

      if (freezes.length > 0) {
        // 宿主卡住：挂起整个宿主进程 N 毫秒（同 drill-safety），页面照常应答，应答在套接字里排队。
        const suspender = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', SUSPENDER],
          { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true },
        );
        const replies = new Lines(suspender.stdout, true);
        await replies.wait((l) => l.event === 'ready', 15_000);
        const pid = session.host.pid;
        const trials: Array<Record<string, unknown>> = [];
        try {
          for (const ms of freezes) {
            const from = host.items.length;
            const watchdogFrom = watchdog.items.length;
            const replyFrom = replies.items.length;
            const t0 = Date.now();
            suspender.stdin?.write(`suspend ${pid}\n`);
            await replies.wait((l) => l.event.startsWith('suspend'), 5000, replyFrom);
            await sleep(ms);
            suspender.stdin?.write(`resume ${pid}\n`);
            await replies.wait((l) => l.event.startsWith('resume'), 5000, replyFrom);
            await sleep(8000);
            const acted = watchdog.items
              .slice(watchdogFrom)
              .find((l) => l.event === 'watchdog.acted');
            const trial = {
              freezeMs: ms,
              watchdogActed: acted
                ? { s: round((Date.parse(acted.t) - t0) / 1000, 2), reason: acted.reason }
                : null,
              events: stageEvents(from, t0),
              stageState: await status(),
            };
            trials.push(trial);
            say(`挂起 ${ms}ms：${JSON.stringify(trial)}`);
            // 看门狗动作过就切回原场景、取消静音，再等 Stage 服务恢复。
            ok(await obs.request('SetCurrentProgramScene', { sceneName: scene }));
            ok(await obs.request('SetInputMute', { inputName: stageSource, inputMuted: false }));
            for (const deadline = Date.now() + 15_000; Date.now() < deadline; ) {
              if ((await status())?.state === 'active') break;
              await sleep(500);
            }
            await sleep(3000);
          }
        } finally {
          suspender.stdin?.write(`resume ${pid}\n`);
          suspender.stdin?.end();
        }
        result.freezes = trials;
        await call(OperatorMethod.EmergencyStop, { reason: '演练结束' });
        operator.connection.close();
      } else {
        const estopFrom = host.items.length;
        const estopAt = Date.now();
        const estop = await call(OperatorMethod.EmergencyStop, {
          reason: '演练：急停后观察 Stage 服务',
        });
        say(`已急停，观察 ${inactiveMs / 1000} 秒`);
        await sleep(inactiveMs);
        const afterEstop = {
          estop,
          programScene: ok(await obs.request('GetCurrentProgramScene')).currentProgramSceneName,
          events: stageEvents(estopFrom, estopAt),
          stageState: await status(),
        };
        // 操作员把场景切回来并取消静音。
        const backFrom = host.items.length;
        const backAt = Date.now();
        ok(await obs.request('SetCurrentProgramScene', { sceneName: scene }));
        ok(await obs.request('SetInputMute', { inputName: stageSource, inputMuted: false }));
        say('已切回原场景，观察 30 秒');
        await sleep(30_000);
        const afterReturn: Record<string, unknown> = {
          events: stageEvents(backFrom, backAt),
          stageState: await status(),
          preflightM2: null,
        };
        await call(OperatorMethod.Presence);
        afterReturn.preflightM2 = (await call(OperatorMethod.Preflight, { target: 'M2' })).failures;
        const m2At = Date.now();
        const m2 = await call(OperatorMethod.Mode, { target: 'M2' });
        afterReturn.modeM2 = m2;
        if (m2.ok === true) {
          const from = host.items.length;
          const played = await host
            .wait(
              (l) =>
                l.event === 'fact' &&
                l.type === 'utterance.played' &&
                (l.data as { end?: string }).end === 'complete',
              20_000,
              from,
            )
            .catch(() => undefined);
          afterReturn.playback = played
            ? {
                utterance: played.data,
                loudReadings: loud.filter((t) => t >= m2At && t <= Date.parse(played.t)).length,
              }
            : '20 秒内没有完整播出';
        }
        await call(OperatorMethod.EmergencyStop, { reason: '演练结束' });
        operator.connection.close();
        result.host = { afterEstop, afterReturn };
        say(`第二部分：${JSON.stringify(result.host)}`);
      }
    }
  } catch (error) {
    result.error = (error as Error).stack ?? String(error);
    say(`诊断中止：${(error as Error).message}`);
  } finally {
    await harness?.close().catch(() => {});
    await session?.stop();
    meters.close();
    const steps = await restoreSnapshot(obs, original, stageSource);
    // 场景项的可见性不在盘点里，单独恢复成显示。
    const itemId = await obs.request('GetSceneItemId', {
      sceneName: scene,
      sourceName: stageSource,
    });
    if (itemId.ok)
      await obs.request('SetSceneItemEnabled', {
        sceneName: scene,
        sceneItemId: itemId.data?.sceneItemId,
        sceneItemEnabled: true,
      });
    const diffs = differences(original, await snapshot(obs, stageSource, safeScene));
    result.obsRestored = { ok: steps.length === 0 && diffs.length === 0, steps, diffs };
    say(`OBS 恢复：${JSON.stringify(result.obsRestored)}`);
    obs.close();
    await store.delete(OBS_SECRET);
    await store.delete(SESSION_SECRET);
    for (const path of [configPath, profilePath]) rmSync(path, { force: true });
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${storePath}${suffix}`, { force: true });
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    `${out}.json`,
    `${JSON.stringify({ drill: 'stage-inactive', started, finished: new Date().toISOString(), node: process.version, stageSource, ...result }, null, 2)}\n`,
  );
  console.log(`结果已写入 ${out}.json`);
}

await main();
