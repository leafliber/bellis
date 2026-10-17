/**
 * P1 第 3 步的真机演练：真实宿主、看门狗与 OBS 上的急停与看门狗（P1 任务卡出口“OBS 与安全核”）。
 *
 *   node spikes/drill-safety.ts --stage-source 名字 [--safe-scene Safe] [--trials N] [--crash-trials N]
 *                               [--out 结果文件]
 *
 * 用启动器的 launch() 拉起真实的宿主与看门狗（live 示例配置，profile 含 OBS 控制），操作员连接切到 M1 后：
 *   estop   操作员急停：从发出 operator.emergency_stop 到它返回（安全核的 RequestBatch 已在 OBS 执行完）。
 *   freeze  宿主卡死：挂起宿主进程（NtSuspendProcess），到看门狗日志里的 watchdog.acted；
 *           恢复后核对宿主读到了看门狗的报告、记录了 watchdog.acted 并进入安全停止。
 *   crash   宿主崩溃：强制终止宿主进程，到 watchdog.acted。宿主不会自动重启，每次重新拉起会话。
 * 另在本进程里装配安全核与 OBS 控制插件，对真实 OBS 各执行一次切场景、静音与写浏览器源设置（写回原值）。
 * 宿主仍在而管道断开的情形由 S-10 与单元测试覆盖：从外部断不开真实宿主的管道。
 *
 * 会切换 OBS 的节目场景并静音 Stage 源；推流或录制进行中时拒绝运行，结束后恢复原来的场景与静音状态。
 * 用临时的 SecretStore 服务名存放会话信息与 OBS 凭据副本，结束时删除，不碰 bellis 下的条目。
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { connect, decodeSessionKey, RpcPeer } from '@bellis/channel';
import { loadConfig, OBS_SECRET, readObsSecret, writeObsSecret } from '@bellis/config';
import { catalog, definePlugin, Kernel, systemClock } from '@bellis/kernel';
import { launch, type Session } from '@bellis/launcher';
import { ObsClient, type ObsResult } from '@bellis/obs';
import { OperatorMethod, Role } from '@bellis/protocol';
import { SafetyCore, SafetyService, safetyFacade } from '@bellis/safety';
import { KeyringSecretStore, SESSION_SECRET } from '@bellis/secret-store';
import {
  type ObsAction,
  ObsConnectorService,
  type ObsControl,
  ObsControlService,
  obsControl,
} from '@bellis/stage';
import { StateStore } from '@bellis/store';
import Type from 'typebox';

const file = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const hostMain = file('../packages/host/src/main.ts');
const watchdogMain = file('../packages/watchdog/src/main.ts');
const liveExample = file('../config/live.example.json');
const liveProfile = file('../config/profiles/live.example.json');

/** 常驻的 PowerShell：按行读入 `suspend <pid>` / `resume <pid>`，挂起或恢复整个进程后回一行。 */
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

/** 逐行收集 JSON 日志，按位置等待某一行出现。 */
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

function summarize(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    n: sorted.length,
    min: round(sorted[0] ?? 0),
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted[sorted.length - 1] ?? 0),
  };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

interface Context {
  obs: ObsClient;
  stageSource: string;
  safeScene: string;
  original: { scene: string; muted: boolean };
  configPath: string;
  service: string;
}

/** 一次会话：真实的宿主与看门狗，加一个操作员连接。 */
class Live {
  readonly session: Session;
  readonly operator: RpcPeer;
  readonly host: Lines;
  readonly watchdog: Lines;

  private constructor(session: Session, operator: RpcPeer) {
    this.session = session;
    this.operator = operator;
    this.host = new Lines(session.host.stdout);
    this.watchdog = new Lines(session.watchdog.stdout);
  }

  static async start(ctx: Context): Promise<Live> {
    const session = await launch({
      configPath: ctx.configPath,
      secretService: ctx.service,
      host: { command: process.execPath, args: [hostMain] },
      watchdog: { command: process.execPath, args: [watchdogMain] },
      stdout: 'pipe',
    });
    const key = decodeSessionKey(session.info.channelKey);
    const operator = new RpcPeer(await connect(session.info.channelPath, Role.Operator, { key }), {
      timeoutMs: 5000,
    });
    const live = new Live(session, operator);
    await live.watchdog.wait((line) => line.event === 'watchdog.obs-connected', 10_000);
    // 宿主内的 OBS 控制经宿主交出的连接连上真实 OBS。
    await live.host.wait((line) => line.event === 'obs-control.connected', 10_000);
    return live;
  }

  async status(): Promise<Record<string, unknown>> {
    return (await this.operator.request(OperatorMethod.Status)) as Record<string, unknown>;
  }

  async toM1(ctx: Context): Promise<void> {
    ok(await ctx.obs.request('SetCurrentProgramScene', { sceneName: ctx.original.scene }));
    ok(await ctx.obs.request('SetInputMute', { inputName: ctx.stageSource, inputMuted: false }));
    const result = (await this.operator.request(OperatorMethod.Mode, { target: 'M1' })) as {
      ok: boolean;
      reason?: string;
    };
    if (!result.ok) throw new Error(`进入 M1 失败：${result.reason}`);
    // 稳定收发几轮心跳后再注入故障。
    await sleep(1500);
  }

  async stop(): Promise<void> {
    this.operator.connection.close();
    await this.session.stop();
  }
}

async function verifySafe(ctx: Context) {
  const scene = ok(await ctx.obs.request('GetCurrentProgramScene'));
  const mute = ok(await ctx.obs.request('GetInputMute', { inputName: ctx.stageSource }));
  return {
    sceneOk: scene.currentProgramSceneName === ctx.safeScene,
    muteOk: mute.inputMuted === true,
  };
}

async function estopTrial(ctx: Context, live: Live) {
  await live.toM1(ctx);
  const started = performance.now();
  const report = (await live.operator.request(OperatorMethod.EmergencyStop, {
    reason: '演练：操作员急停',
  })) as { obs: { ok: boolean } };
  const ms = performance.now() - started;
  const status = await live.status();
  return { ms, obsOk: report.obs.ok, mode: status.mode, ...(await verifySafe(ctx)) };
}

async function freezeTrial(ctx: Context, live: Live, suspender: ChildProcess, replies: Lines) {
  await live.toM1(ctx);
  const watchdogFrom = live.watchdog.items.length;
  const hostFrom = live.host.items.length;
  const pid = live.session.host.pid;
  let replyFrom = replies.items.length;
  suspender.stdin?.write(`suspend ${pid}\n`);
  await replies.wait((line) => line.event.startsWith('suspend'), 5000, replyFrom);
  const suspendedAt = Date.now();
  let resumed = false;
  try {
    const acted = await live.watchdog.wait(
      (l) => l.event === 'watchdog.acted',
      10_000,
      watchdogFrom,
    );
    const safe = await verifySafe(ctx);
    const reported = await live.watchdog.wait(
      (l) => l.event === 'watchdog.reported',
      5000,
      watchdogFrom,
    );
    replyFrom = replies.items.length;
    suspender.stdin?.write(`resume ${pid}\n`);
    await replies.wait((line) => line.event.startsWith('resume'), 5000, replyFrom);
    resumed = true;
    const resumedAt = Date.now();
    const fact = await live.host.wait(
      (l) => l.event === 'fact' && l.type === 'watchdog.acted',
      5000,
      hostFrom,
    );
    const status = await live.status();
    return {
      actedMs: Date.parse(acted.t) - suspendedAt,
      batchOk: acted.ok === true,
      reportedReason: reported.reason,
      hostRecordedAfterResumeMs: Date.parse(fact.t) - resumedAt,
      mode: status.mode,
      ...safe,
    };
  } finally {
    if (!resumed) suspender.stdin?.write(`resume ${pid}\n`);
  }
}

async function crashTrial(ctx: Context) {
  const live = await Live.start(ctx);
  try {
    await live.toM1(ctx);
    const from = live.watchdog.items.length;
    const killedAt = Date.now();
    process.kill(live.session.host.pid);
    const acted = await live.watchdog.wait((l) => l.event === 'watchdog.acted', 10_000, from);
    return {
      actedMs: Date.parse(acted.t) - killedAt,
      reason: acted.reason,
      batchOk: acted.ok === true,
      ...(await verifySafe(ctx)),
    };
  } finally {
    await live.stop();
  }
}

/** 本进程里装配安全核与 OBS 控制插件，对真实 OBS 执行每种动作一次；设置写回原值。 */
async function obsControlCheck(ctx: Context, secret: { url: string; password?: string }) {
  const path = join(tmpdir(), `${ctx.service}-control.db`);
  const store = StateStore.open({ path });
  const clock = systemClock();
  let kernel: Kernel | undefined;
  const core = new SafetyCore({
    store,
    clock,
    config: {
      ...loadConfig(ctx.configPath).safety,
      simulation: false,
    },
    obs: { ready: true, run: async () => ({ ok: true, results: [] }) },
    permissionsOf: (holder) => kernel?.permissionsOf(holder),
    watchdogConnected: () => true,
  });
  kernel = new Kernel({ clock, safety: core.kernelHooks() });
  kernel.provideScoped(SafetyService, ({ instanceId }) => safetyFacade(core, instanceId));
  kernel.provideCore(ObsConnectorService, {
    connect: () => ObsClient.connect(secret.url, secret.password),
  });
  let caller: { run(action: ObsAction, capability: string): Promise<unknown> } | undefined;
  let next = 0;
  const callerPlugin = definePlugin({
    manifest: {
      id: 'drill-caller',
      version: '1.0.0',
      tier: 'ordinary',
      provides: [],
      inject: [SafetyService.ref, ObsControlService.ref],
      permissions: [],
      process: 'in-process',
      config: Type.Object({}),
    },
    activate(pluginCtx) {
      const safety = pluginCtx.service(SafetyService);
      const control: ObsControl = pluginCtx.service(ObsControlService);
      caller = {
        async run(action, capability) {
          next += 1;
          const decision = await safety.authorize({
            key: `drill-${next}`,
            type: `obs.${action.kind}`,
            target: 'obs',
            payload: action,
            source: { origin: 'drill', inputs: [], untrusted: false },
            capabilities: [capability],
            timeSensitive: true,
          });
          if (!decision.allowed) throw new Error(decision.reason);
          const started = performance.now();
          const intent = await control.run(decision.intent, action);
          return { state: intent.state, error: intent.error, ms: performance.now() - started };
        },
      };
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
        id: 'caller',
        plugin: 'drill-caller',
        config: {},
        disabled: false,
        explicitSwitch: false,
        grant: ['obs.scene', 'obs.audio', 'obs.source'],
      },
    ],
    catalog(obsControl, callerPlugin),
  );
  await kernel.settled();
  try {
    if (!caller) throw new Error('演练调用方未激活');
    if (!core.requestMode('M1').ok) throw new Error('本进程安全核进不了 M1');
    const settings = ok(await ctx.obs.request('GetInputSettings', { inputName: ctx.stageSource }));
    const url = (settings.inputSettings as Record<string, unknown>).url;
    const results = {
      scene: await caller.run({ kind: 'scene', sceneName: ctx.original.scene }, 'obs.scene'),
      mute: await caller.run(
        { kind: 'mute', inputName: ctx.stageSource, muted: true },
        'obs.audio',
      ),
      mutedObserved: ok(await ctx.obs.request('GetInputMute', { inputName: ctx.stageSource }))
        .inputMuted,
      unmute: await caller.run(
        { kind: 'mute', inputName: ctx.stageSource, muted: false },
        'obs.audio',
      ),
      settings: await caller.run(
        { kind: 'input-settings', inputName: ctx.stageSource, inputSettings: { url } },
        'obs.source',
      ),
      urlUnchanged:
        (
          ok(await ctx.obs.request('GetInputSettings', { inputName: ctx.stageSource }))
            .inputSettings as Record<string, unknown>
        ).url === url,
    };
    await core.emergencyStop('演练结束');
    const refused = await caller.run({ kind: 'scene', sceneName: ctx.safeScene }, 'obs.scene').then(
      () => 'allowed',
      (error: Error) => error.message,
    );
    return { ...results, afterSafeStop: refused };
  } finally {
    await kernel.shutdown();
    store.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'stage-source': { type: 'string' },
      'safe-scene': { type: 'string', default: 'Safe' },
      trials: { type: 'string', default: '10' },
      'crash-trials': { type: 'string', default: '5' },
      out: { type: 'string' },
    },
  });
  const stageSource = values['stage-source'];
  if (!stageSource) throw new Error('需要 --stage-source');
  const safeScene = values['safe-scene'];
  const trials = Number(values.trials);

  const secret = await readObsSecret(new KeyringSecretStore('bellis'), OBS_SECRET);
  const obs = await ObsClient.connect(secret.url, secret.password);
  const service = `bellis-drill-${randomBytes(4).toString('hex')}`;
  const store = new KeyringSecretStore(service);
  const configPath = join(tmpdir(), `${service}.json`);
  const started = new Date().toISOString();
  const suspender = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', SUSPENDER],
    {
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    },
  );
  const replies = new Lines(suspender.stdout, true);
  let original: Context['original'] | undefined;
  const results: Record<string, unknown[]> = { estop: [], freeze: [], crash: [] };
  let control: unknown;
  try {
    await replies.wait((line) => line.event === 'ready', 30_000);
    if (ok(await obs.request('GetStreamStatus')).outputActive)
      throw new Error('推流进行中，拒绝运行');
    if (ok(await obs.request('GetRecordStatus')).outputActive)
      throw new Error('录制进行中，拒绝运行');
    const scenes = ok(await obs.request('GetSceneList'));
    if (!(scenes.scenes as Array<{ sceneName: string }>).some((s) => s.sceneName === safeScene))
      throw new Error(`没有安全场景「${safeScene}」`);
    original = {
      scene: scenes.currentProgramSceneName as string,
      muted: ok(await obs.request('GetInputMute', { inputName: stageSource }))
        .inputMuted as boolean,
    };
    if (original.scene === safeScene) throw new Error('节目场景已经是安全场景，无法观察切换');

    await writeObsSecret(store, secret, OBS_SECRET);
    const config = JSON.parse(JSON.stringify(loadConfig(liveExample)));
    config.profile = liveProfile;
    config.safety.emergency = { stageSource, safeScene, stopStream: false };
    config.storePath = join(tmpdir(), `${service}.db`);
    writeFileSync(configPath, JSON.stringify(config));
    const ctx: Context = { obs, stageSource, safeScene, original, configPath, service };

    console.log('OBS 控制插件');
    control = await obsControlCheck(ctx, secret);
    console.log(JSON.stringify(control));

    const live = await Live.start(ctx);
    try {
      for (let n = 0; n < trials; n++) {
        const result = await estopTrial(ctx, live).catch((error: Error) => ({
          error: error.message,
        }));
        results.estop?.push(result);
        console.log(`estop #${n + 1}：${JSON.stringify(result)}`);
      }
      for (let n = 0; n < trials; n++) {
        const result = await freezeTrial(ctx, live, suspender, replies).catch((error: Error) => ({
          error: error.message,
        }));
        results.freeze?.push(result);
        console.log(`freeze #${n + 1}：${JSON.stringify(result)}`);
      }
    } finally {
      await live.stop();
    }
    for (let n = 0; n < Number(values['crash-trials']); n++) {
      const result = await crashTrial(ctx).catch((error: Error) => ({ error: error.message }));
      results.crash?.push(result);
      console.log(`crash #${n + 1}：${JSON.stringify(result)}`);
    }
  } finally {
    suspender.stdin?.end();
    if (original) {
      await obs.request('SetCurrentProgramScene', { sceneName: original.scene });
      await obs.request('SetInputMute', { inputName: stageSource, inputMuted: original.muted });
    }
    obs.close();
    await store.delete(OBS_SECRET);
    await store.delete(SESSION_SECRET);
    for (const suffix of ['', '.db', '.db-wal', '.db-shm']) {
      rmSync(suffix === '' ? configPath : join(tmpdir(), `${service}${suffix}`), { force: true });
    }
  }

  const numbers = (kind: string, field: string) =>
    (results[kind] ?? [])
      .map((r) => (r as Record<string, unknown>)[field])
      .filter((v): v is number => typeof v === 'number');
  const failed = (kind: string) =>
    (results[kind] ?? []).filter((r) => 'error' in (r as object)).length;
  const verified = (kind: string, extra: (r: Record<string, unknown>) => boolean) =>
    (results[kind] ?? []).every((r) => {
      const x = r as Record<string, unknown>;
      return !('error' in x) && x.sceneOk === true && x.muteOk === true && extra(x);
    });
  const summary = {
    estop: {
      failed: failed('estop'),
      allVerified: verified('estop', (r) => r.obsOk === true && r.mode === 'safe-stop'),
      ms: summarize(numbers('estop', 'ms')),
    },
    freeze: {
      failed: failed('freeze'),
      allVerified: verified(
        'freeze',
        (r) =>
          r.batchOk === true && r.mode === 'safe-stop' && r.reportedReason === 'heartbeat-lost',
      ),
      actedMs: summarize(numbers('freeze', 'actedMs')),
      hostRecordedAfterResumeMs: summarize(numbers('freeze', 'hostRecordedAfterResumeMs')),
    },
    crash: {
      failed: failed('crash'),
      allVerified: verified('crash', (r) => r.batchOk === true && r.reason === 'connection-lost'),
      actedMs: summarize(numbers('crash', 'actedMs')),
    },
  };
  const out = resolve(values.out ?? join('reports', `drill-safety-${started.slice(0, 10)}.json`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    `${JSON.stringify({ drill: 'safety', started, finished: new Date().toISOString(), node: process.version, stageSource, safeScene, control, summary, results }, null, 2)}\n`,
  );
  console.log(JSON.stringify(summary, null, 2));
  console.log(`结果已写入 ${out}`);
}

await main();
