/**
 * P1 第 7 步的真机演练：VTube Studio 形象（P1 任务卡出口“发声与形象”中形象的各项）。
 *
 *   node spikes/drill-avatar.ts --stage-source 名字 --avatar-source 名字 [--safe-scene Safe] [--out 结果文件]
 *
 * 前提：VTS 已开启插件 API（ws://127.0.0.1:8001）并载入模型；OBS 的直播场景里有采集 VTS 的游戏采集源
 * （--avatar-source），安全场景里没有它。
 *
 * 本进程另以插件「Bellis Drill」连上 VTS 作观察者（令牌只在内存里，每次运行在 VTS 中允许一次），
 * 以约 40Hz 读嘴型参数的值。宿主用缺省的 SecretStore 服务名 bellis：形象插件的令牌像正式运行一样存进
 * bellis 的 vts 条目（第一次运行时维护者在 VTS 中允许「Bellis」）。依次核对：
 *   1. 参数占用：观察者先以 set 模式写嘴型参数，宿主的形象插件记 avatar.injection-stopped、报告未就绪，
 *      开播预检列出形象未就绪。
 *   2. 口型跟随播放：M2 下 440Hz 测试音的定时播报播出时嘴型张开，句间为 0；粗测音量表出声到嘴型张开的时间。
 *   3. 宿主失联：说话中挂起宿主进程（重复 --trials 次），量嘴型归位（VTS 收不到注入约 1 秒后交还控制）的时间；
 *      看门狗切到安全场景后核对形象源不在节目场景里。最后操作员急停一次，核对同样不可见、嘴型归位。
 *
 * 会改写浏览器源的 URL、切换节目场景并静音；推流或录制进行中时拒绝运行，结束后恢复。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { VTS_PLUGIN_DEVELOPER, VtsClient } from '@bellis/avatar';
import { connect, decodeSessionKey, RpcPeer } from '@bellis/channel';
import { loadConfig, OBS_SECRET, readObsSecret } from '@bellis/config';
import { systemClock } from '@bellis/kernel';
import { launch, type Session } from '@bellis/launcher';
import { ObsClient, type ObsResult } from '@bellis/obs';
import { OperatorMethod, Role } from '@bellis/protocol';
import { KeyringSecretStore } from '@bellis/secret-store';
import { type MeterReading, ObsMeters } from './s01-stage/meters.ts';

const file = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const hostMain = file('../packages/host/src/main.ts');
const watchdogMain = file('../packages/watchdog/src/main.ts');
const liveExample = file('../config/live.example.json');
const VTS_URL = 'ws://127.0.0.1:8001';
const OBSERVER = { pluginName: 'Bellis Drill', pluginDeveloper: VTS_PLUGIN_DEVELOPER };
const MOUTH = 'MouthOpen';
const SOUND_DB = -40;
const EVERY_MS = 8000;
const TEXT = '这是一句用来核对口型的测试播报。';

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
      if (raw) this.items.push({ t: new Date().toISOString(), event: line });
      else {
        try {
          this.items.push(JSON.parse(line) as LogLine);
        } catch {
          return;
        }
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
const fact = (type: string) => (line: LogLine) => line.event === 'fact' && line.type === type;
const say = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
}

/** 观察者：以「Bellis 演练」认证，读或写嘴型参数。令牌只在内存里，不写出。 */
async function observer(): Promise<VtsClient> {
  const clock = systemClock();
  const vts = await VtsClient.connect(VTS_URL, clock, 3000);
  say('请在 VTube Studio 中允许插件「Bellis Drill」（观察者，令牌不保存）');
  const granted = await vts.request('AuthenticationTokenRequest', OBSERVER, 300_000);
  if (!granted.ok) throw new Error(`观察者的令牌申请被拒：${granted.errorId} ${granted.message}`);
  const token = granted.data.authenticationToken;
  if (typeof token !== 'string') throw new Error('观察者没拿到令牌');
  const auth = await vts.request(
    'AuthenticationRequest',
    { ...OBSERVER, authenticationToken: token },
    3000,
  );
  if (!auth.ok || auth.data.authenticated !== true) throw new Error('观察者认证失败');
  return vts;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'stage-source': { type: 'string' },
      'avatar-source': { type: 'string' },
      'safe-scene': { type: 'string', default: 'Safe' },
      /** 宿主失联重复的次数。 */
      trials: { type: 'string', default: '5' },
      out: { type: 'string' },
    },
  });
  const stageSource = values['stage-source'];
  const avatarSource = values['avatar-source'];
  if (!stageSource || !avatarSource) throw new Error('需要 --stage-source 与 --avatar-source');
  const safeScene = values['safe-scene'];
  const trialCount = Number(values.trials);

  const secret = await readObsSecret(new KeyringSecretStore('bellis'), OBS_SECRET);
  const obs = await ObsClient.connect(secret.url, secret.password);
  const loud: number[] = [];
  const meters = await ObsMeters.connect(
    secret.url,
    secret.password,
    (readings: MeterReading[]) => {
      const reading = readings.find((r) => r.name === stageSource);
      if (reading && reading.peakDb > SOUND_DB) loud.push(Date.now());
    },
  );
  const suspender = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', SUSPENDER],
    {
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    },
  );
  const replies = new Lines(suspender.stdout, true);
  const started = new Date().toISOString();
  const id = `${Date.now().toString(36)}`;
  const configPath = join(tmpdir(), `bellis-drill-avatar-${id}.json`);
  const profilePath = join(tmpdir(), `bellis-drill-avatar-${id}.profile.json`);
  const storePath = join(tmpdir(), `bellis-drill-avatar-${id}.db`);
  let original: { scene: string; muted: boolean; settings: Record<string, unknown> } | undefined;
  let session: Session | undefined;
  let vts: VtsClient | undefined;
  let suspendedPid: number | undefined;
  const result: Record<string, unknown> = {};
  /** 观察者读到的嘴型参数：[时刻, 值]。 */
  const mouth: Array<[number, number]> = [];
  let reading = false;
  let injecting = false;
  try {
    await replies.wait((line) => line.event === 'ready', 30_000);
    if (ok(await obs.request('GetStreamStatus')).outputActive)
      throw new Error('推流进行中，拒绝运行');
    if (ok(await obs.request('GetRecordStatus')).outputActive)
      throw new Error('录制进行中，拒绝运行');
    original = {
      scene: ok(await obs.request('GetCurrentProgramScene')).currentProgramSceneName as string,
      muted: ok(await obs.request('GetInputMute', { inputName: stageSource }))
        .inputMuted as boolean,
      settings: ok(await obs.request('GetInputSettings', { inputName: stageSource }))
        .inputSettings as Record<string, unknown>,
    };
    if (original.scene === safeScene) throw new Error('节目场景已经是安全场景');
    const itemsOf = async (scene: string) =>
      (
        ok(await obs.request('GetSceneItemList', { sceneName: scene })).sceneItems as Array<{
          sourceName: string;
          sceneItemEnabled: boolean;
        }>
      ).map((i) => ({ name: i.sourceName, enabled: i.sceneItemEnabled }));
    const liveItems = await itemsOf(original.scene);
    if (!liveItems.some((i) => i.name === avatarSource && i.enabled))
      throw new Error(`直播场景「${original.scene}」里没有启用的形象源「${avatarSource}」`);
    if ((await itemsOf(safeScene)).some((i) => i.name === avatarSource))
      throw new Error(`安全场景「${safeScene}」里有形象源「${avatarSource}」`);
    const avatarInput = ok(await obs.request('GetInputSettings', { inputName: avatarSource }));
    result.avatarSource = { name: avatarSource, kind: avatarInput.inputKind };
    ok(await obs.request('SetInputMute', { inputName: stageSource, inputMuted: false }));

    vts = await observer();
    const model = await vts.request('CurrentModelRequest', {}, 3000);
    result.vts = {
      modelLoaded: model.ok ? model.data.modelLoaded : null,
      modelName: model.ok ? model.data.modelName : null,
    };
    say(`VTS 模型：${JSON.stringify(result.vts)}`);
    const observerClient = vts;
    const readLoop = async () => {
      reading = true;
      while (reading) {
        const at = Date.now();
        const answer = await observerClient
          .request('ParameterValueRequest', { name: MOUTH }, 1000)
          .catch(() => undefined);
        if (answer?.ok && typeof answer.data.value === 'number')
          mouth.push([at, answer.data.value]);
        await sleep(Math.max(0, 25 - (Date.now() - at)));
      }
    };
    const injectLoop = async () => {
      injecting = true;
      while (injecting) {
        await observerClient
          .request(
            'InjectParameterDataRequest',
            { faceFound: false, mode: 'set', parameterValues: [{ id: MOUTH, value: 0.3 }] },
            1000,
          )
          .catch(() => undefined);
        await sleep(200);
      }
    };
    void readLoop();

    const announcements = Array.from({ length: 60 }, (_, i) => ({
      id: `a${i}`,
      atMs: 4000 + i * EVERY_MS,
      text: TEXT,
    }));
    writeFileSync(
      profilePath,
      JSON.stringify({
        name: 'drill-avatar',
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
              { id: 'avatar', plugin: 'avatar-vts', grant: ['secret:vts'] },
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

    const start = async () => {
      const s = await launch({
        configPath,
        // 用正式的服务名：形象插件的令牌像正式运行一样存进 bellis 的 vts 条目。
        secretService: 'bellis',
        host: { command: process.execPath, args: [hostMain] },
        watchdog: { command: process.execPath, args: [watchdogMain] },
        stdout: 'pipe',
      });
      const host = new Lines(s.host.stdout);
      const watchdog = new Lines(s.watchdog.stdout);
      const key = decodeSessionKey(s.info.channelKey);
      const operator = new RpcPeer(await connect(s.info.channelPath, Role.Operator, { key }), {
        timeoutMs: 10_000,
      });
      const call = (method: string, params: Record<string, unknown> = {}) =>
        operator.request(method, params) as Promise<Record<string, unknown>>;
      // 第一次运行时形象插件申请令牌，等维护者在 VTS 中允许。
      void host
        .wait((l) => l.event === 'avatar.token-requested', 60_000)
        .then(() =>
          say('请在 VTube Studio 中允许插件「Bellis」（令牌存进 SecretStore 的 vts 条目）'),
        )
        .catch(() => undefined);
      await host.wait((l) => l.event === 'avatar.authenticated', 300_000);
      return { s, host, watchdog, operator, call };
    };

    // 1. 参数占用。
    void injectLoop();
    await sleep(500);
    let run = await start();
    session = run.s;
    const stoppedLine = await run.host.wait((l) => l.event === 'avatar.injection-stopped', 15_000);
    await run.call(OperatorMethod.Presence);
    result.occupied = {
      injectionStopped: {
        parameter: stoppedLine.parameter,
        errorId: stoppedLine.errorId,
        reason: stoppedLine.reason,
      },
      preflightM2: (await run.call(OperatorMethod.Preflight, { target: 'M2' })).failures,
    };
    say(`参数占用：${JSON.stringify(result.occupied)}`);
    run.operator.connection.close();
    await session.stop();
    session = undefined;
    injecting = false;
    // 计划内停止时宿主切到了安全场景并静音（预检因此不通过）：像操作员一样切回直播场景、取消静音。
    ok(await obs.request('SetCurrentProgramScene', { sceneName: original.scene }));
    ok(await obs.request('SetInputMute', { inputName: stageSource, inputMuted: false }));
    await sleep(2000);

    // 2. 口型跟随播放。
    run = await start();
    session = run.s;
    const { host, watchdog, call } = run;
    await host.wait((l) => l.event === 'stage-page.authenticated', 30_000);
    await call(OperatorMethod.Presence);
    for (const deadline = Date.now() + 30_000; ; ) {
      const failures = (await call(OperatorMethod.Preflight, { target: 'M2' }))
        .failures as string[];
      if (failures.length === 0) break;
      if (Date.now() > deadline) throw new Error(`预检未通过：${failures.join('；')}`);
      await sleep(300);
    }
    const m2 = await call(OperatorMethod.Mode, { target: 'M2' });
    if (m2.ok !== true) throw new Error(`进入 M2 失败：${JSON.stringify(m2)}`);
    const m2At = Date.now();
    say('已切到 M2');
    let from = host.items.length;
    const played: LogLine[] = [];
    while (played.length < 3) {
      const line = await host.wait(fact('utterance.played'), EVERY_MS * 3, from);
      from = host.items.indexOf(line) + 1;
      played.push(line);
    }
    const windowEnd = Date.now();
    /** 有声的时段：相邻的有声读数间隔不超过 200ms 的连成一段。 */
    const spans: Array<[number, number]> = [];
    for (const t of loud.filter((t) => t >= m2At && t <= windowEnd)) {
      const last = spans.at(-1);
      if (last && t - last[1] <= 200) last[1] = t;
      else spans.push([t, t]);
    }
    const inside = (t: number) => spans.some(([a, b]) => t >= a && t <= b);
    const near = (t: number) => spans.some(([a, b]) => t >= a - 300 && t <= b + 300);
    const during = mouth
      .filter(([t]) => t >= m2At && t <= windowEnd && inside(t))
      .map(([, v]) => v);
    const between = mouth
      .filter(([t]) => t >= m2At && t <= windowEnd && !near(t))
      .map(([, v]) => v);
    const onsets = spans.map(([a]) => {
      const open = mouth.find(([t, v]) => t >= a - 500 && v > 0.3);
      return open ? open[0] - a : null;
    });
    const closes = spans.map(([, b]) => {
      const shut = mouth.find(([t, v]) => t >= b && v < 0.05);
      return shut ? shut[0] - b : null;
    });
    result.following = {
      utterances: played.map((l) => l.data),
      soundSpans: spans.map(([a, b]) => ({ ms: b - a })),
      mouthWhileSound: {
        n: during.length,
        p5: percentile(during, 5),
        p50: percentile(during, 50),
        max: percentile(during, 100),
      },
      mouthBetween: { n: between.length, max: percentile(between, 100) },
      soundToMouthOpenMs: onsets,
      soundEndToMouthClosedMs: closes,
      readIntervalMs: percentile(
        mouth.slice(1).map(([t], i) => t - (mouth[i] as [number, number])[0]),
        50,
      ),
    };
    say(`口型跟随：${JSON.stringify(result.following)}`);

    // 3. 宿主失联：说话中挂起宿主，重复 --trials 次；最后改由操作员急停一次。
    const live = original.scene;
    const enterM2 = async () => {
      ok(await obs.request('SetCurrentProgramScene', { sceneName: live }));
      ok(await obs.request('SetInputMute', { inputName: stageSource, inputMuted: false }));
      await call(OperatorMethod.Presence);
      for (const deadline = Date.now() + 30_000; ; ) {
        const failures = (await call(OperatorMethod.Preflight, { target: 'M2' }))
          .failures as string[];
        if (failures.length === 0) break;
        if (Date.now() > deadline) throw new Error(`预检未通过：${failures.join('；')}`);
        await sleep(300);
      }
      const entered = await call(OperatorMethod.Mode, { target: 'M2' });
      if (entered.ok !== true) throw new Error(`进入 M2 失败：${JSON.stringify(entered)}`);
    };
    /** 等到嘴型张开（正在说话）。 */
    const waitSpeaking = async () => {
      const since = Date.now();
      for (;;) {
        const latest = mouth.at(-1);
        if (latest && latest[0] > since && latest[1] > 0.5) return;
        if (Date.now() - since > EVERY_MS * 2) throw new Error('等不到嘴型张开');
        await sleep(20);
      }
    };
    /** 从 since 起嘴型第一次归位（低于 0.05）的时刻。 */
    const mouthClosedAfter = async (since: number) => {
      for (const deadline = since + 5000; Date.now() < deadline; ) {
        const hit = mouth.find(([t, v]) => t > since && v < 0.05);
        if (hit) return hit[0];
        await sleep(20);
      }
      return undefined;
    };
    const avatarShown = async () => {
      const program = ok(await obs.request('GetCurrentProgramScene'))
        .currentProgramSceneName as string;
      const items = await itemsOf(program);
      return { program, visible: items.some((i) => i.name === avatarSource && i.enabled) };
    };
    const trials: Array<Record<string, unknown>> = [];
    for (let i = 0; i < trialCount; i++) {
      if (i > 0) await enterM2();
      await waitSpeaking();
      // 挂起时刻落在说话中的不同位置。
      await sleep(300 + Math.random() * 700);
      const pid = session.host.pid;
      const hostMark = host.items.length;
      const watchdogMark = watchdog.items.length;
      const before = mouth.at(-1)?.[1] ?? null;
      const suspendAt = Date.now();
      suspender.stdin?.write(`suspend ${pid}
`);
      suspendedPid = pid;
      await replies.wait((l) => l.event.startsWith('suspend'), 5000, replies.items.length - 1);
      const returned = await mouthClosedAfter(suspendAt);
      const acted = await watchdog.wait((l) => l.event === 'watchdog.acted', 5000, watchdogMark);
      const shown = await avatarShown();
      suspender.stdin?.write(`resume ${pid}
`);
      await replies.wait((l) => l.event.startsWith('resume'), 5000, replies.items.length - 1);
      suspendedPid = undefined;
      await host.wait(fact('watchdog.acted'), 10_000, hostMark);
      const trial = {
        mouthBefore: before,
        mouthReturnedMs: returned === undefined ? null : returned - suspendAt,
        watchdogActed: acted.reason,
        watchdogActedMs: Date.parse(acted.t) - suspendAt,
        programScene: shown.program,
        avatarVisible: shown.visible,
        modeAfterResume: (await call(OperatorMethod.Status)).mode,
      };
      trials.push(trial);
      say(`宿主失联 ${i + 1}/${trialCount}：${JSON.stringify(trial)}`);
    }
    const returnedMs = trials
      .map((t) => t.mouthReturnedMs)
      .filter((v): v is number => typeof v === 'number');
    const actedMs = trials.map((t) => t.watchdogActedMs as number);
    result.hostLost = {
      trials,
      mouthReturnedMs: {
        n: returnedMs.length,
        p50: percentile(returnedMs, 50),
        p95: percentile(returnedMs, 95),
        max: percentile(returnedMs, 100),
      },
      watchdogActedMs: {
        n: actedMs.length,
        p50: percentile(actedMs, 50),
        p95: percentile(actedMs, 95),
        max: percentile(actedMs, 100),
      },
      avatarVisibleAfterAct: trials.filter((t) => t.avatarVisible).length,
    };

    // 操作员急停：切到安全场景，形象不可见；仲裁停止说话，嘴型随之归位。
    await enterM2();
    await waitSpeaking();
    await sleep(500);
    const estopAt = Date.now();
    await call(OperatorMethod.EmergencyStop, { reason: '演练：形象急停' });
    const closedAt = await mouthClosedAfter(estopAt);
    const shown = await avatarShown();
    result.estop = {
      mouthClosedMs: closedAt === undefined ? null : closedAt - estopAt,
      programScene: shown.program,
      avatarVisible: shown.visible,
      mode: (await call(OperatorMethod.Status)).mode,
    };
    say(`操作员急停：${JSON.stringify(result.estop)}`);
    run.operator.connection.close();
  } finally {
    reading = false;
    injecting = false;
    if (suspendedPid !== undefined) suspender.stdin?.write(`resume ${suspendedPid}\n`);
    await session?.stop().catch(() => undefined);
    vts?.close();
    meters.close();
    suspender.stdin?.end();
    if (original) {
      await obs.request('SetInputSettings', {
        inputName: stageSource,
        inputSettings: { url: original.settings.url ?? '', reroute_audio: true },
        overlay: true,
      });
      await obs.request('SetCurrentProgramScene', { sceneName: original.scene });
      await obs.request('SetInputMute', { inputName: stageSource, inputMuted: original.muted });
    }
    obs.close();
    for (const path of [configPath, profilePath, storePath, `${storePath}-wal`, `${storePath}-shm`])
      rmSync(path, { force: true });
  }
  const out = resolve(values.out ?? join('reports', `drill-avatar-${started.slice(0, 10)}.json`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    `${JSON.stringify({ drill: 'avatar', started, finished: new Date().toISOString(), node: process.version, stageSource, avatarSource, safeScene, ...result }, null, 2)}\n`,
  );
  say(`结果已写入 ${out}`);
}

await main();
