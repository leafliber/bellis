/**
 * P2 第 7 步的真机演练：OBS 热键急停（R-27）。宿主的 OBS 应急连接订阅节目场景与输入静音的变化，真实输出模式下
 * 节目场景变为安全场景、或 Stage 源被静音，即走完整的急停路径进入安全停止。
 *
 *   node spikes/drill-obs-hotkey.ts [--config config/live.json] [--trials 10]
 *                                   [--hotkey 名字[=上下文] …] [--freeze-trials 3] [--freeze-ms 2000]
 *                                   [--out 结果文件前缀]
 *   node spikes/drill-obs-hotkey.ts --list-hotkeys      只列出 OBS 里的热键名（GetHotkeyList），不拉起宿主
 *
 * 像 `pnpm start` 一样用维护者的真实配置与正式的 SecretStore 服务名 bellis 拉起宿主与看门狗，等 Stage 认证，
 * 确认在场后进入 M2（开播预检要通过）。然后由本脚本另开一条 obs-websocket 连接制造外部变化：
 * - 给了 `--hotkey` 时每轮按顺序触发这些热键（TriggerHotkeyByName；热键名由维护者在 OBS 中绑定后提供，
 *   可重复给出，例如场景与静音各一个；`名字=上下文` 给出 contextName）；
 * - 否则交替用 SetCurrentProgramScene 切到安全场景、SetInputMute 静音 Stage 源。
 * 测从发出请求到宿主记下急停完成（宿主日志里的 safety.emergency-completed）的时间，重复 --trials 次，
 * 每轮之间切回原来的节目场景、取消静音、确认在场、重新进入 M2。报告样本数与 p50/p95/p99/max，失败样本不剔除。
 *
 * 宿主卡死（只在 Windows 上，--freeze-trials 次）：挂起宿主进程（NtSuspendProcess，同 drill-safety）后触发同样的
 * 外部变化（没给 --hotkey 时同时切场景与静音，相当于两项绑在同一个键上），立即读回 OBS，核对已在安全场景且
 * Stage 源已静音（这由 OBS 自己完成）；挂起 --freeze-ms 后恢复，确认宿主随后进入安全停止，并如实记录宿主先读到的是
 * OBS 外部变化还是看门狗的报告（看门狗的心跳超时可能先到）。
 *
 * 会切换节目场景、静音 Stage 源并改写 Stage 浏览器源的 URL；推流进行中、或有别的 Bellis 进程在运行时拒绝运行。
 * 结束后把节目场景、静音与 Stage 源的设置（含 URL）恢复原样并读回比对。结果写 <前缀>.json，宿主与看门狗的日志
 * 写 <前缀>.log（日志里没有凭据）。
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { connect, decodeSessionKey, RpcPeer } from '@bellis/channel';
import { loadConfig, OBS_SECRET, readObsSecret } from '@bellis/config';
import { launch, type Session } from '@bellis/launcher';
import { ObsClient, type ObsResult } from '@bellis/obs';
import { OperatorMethod, Role } from '@bellis/protocol';
import { KeyringSecretStore } from '@bellis/secret-store';
import { waitForNoOtherBellis } from './bellis-processes.ts';
import { differences, type ObsSnapshot, restoreSnapshot, snapshot } from './obs-snapshot.ts';

const file = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const root = file('../');
const hostMain = file('../packages/host/src/main.ts');
const watchdogMain = file('../packages/watchdog/src/main.ts');

/** 常驻的 PowerShell：按行读入 `suspend <pid>` / `resume <pid>`，挂起或恢复整个进程后回一行（同 drill-safety）。 */
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

/** 逐行收集 JSON 日志（raw 时整行作为事件名），按位置等待某一行出现。 */
class Lines {
  readonly items: LogLine[] = [];
  readonly #waiters = new Set<() => void>();

  constructor(stream: Readable | null, sink?: (line: string) => void, raw = false) {
    if (!stream) throw new Error('没有可读的输出');
    createInterface({ input: stream }).on('line', (line) => {
      sink?.(line);
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

  find(match: (line: LogLine) => boolean, from = 0): LogLine | undefined {
    return this.items.slice(from).find(match);
  }

  async wait(match: (line: LogLine) => boolean, timeoutMs: number, from = 0): Promise<LogLine> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.find(match, from);
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
    max: round(sorted.at(-1) ?? 0),
  };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const say = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
const isFact = (type: string) => (line: LogLine) => line.event === 'fact' && line.type === type;

interface Hotkey {
  hotkeyName: string;
  contextName?: string;
}

function parseHotkey(value: string): Hotkey {
  const index = value.indexOf('=');
  if (index < 0) return { hotkeyName: value };
  const hotkeyName = value.slice(0, index);
  const contextName = value.slice(index + 1);
  if (!hotkeyName || !contextName)
    throw new Error(`--hotkey 的格式是 名字 或 名字=上下文：${value}`);
  return { hotkeyName, contextName };
}

/** 读取凭据并连上真实 OBS；缺凭据或连不上时给出清楚的报错（不打印凭据与地址）。 */
async function connectObs(): Promise<ObsClient> {
  let secret: Awaited<ReturnType<typeof readObsSecret>>;
  try {
    secret = await readObsSecret(new KeyringSecretStore('bellis'), OBS_SECRET);
  } catch (error) {
    throw new Error(
      `读不到 OBS 凭据（${(error as Error).message}）。这个演练需要真实 OBS，先用 pnpm secret set obs 录入 obs-websocket 的地址与密码`,
    );
  }
  try {
    return await ObsClient.connect(secret.url, secret.password, { timeoutMs: 3000 });
  } catch (error) {
    throw new Error(
      `连不上 OBS（${(error as Error).message}）。这个演练需要真实 OBS：先启动 OBS、开启 obs-websocket，并核对 pnpm secret set obs 录入的地址与密码`,
    );
  }
}

interface Context {
  obs: ObsClient;
  stageSource: string;
  safeScene: string;
  liveScene: string;
  hotkeys: Hotkey[];
  host: Lines;
  watchdog: Lines;
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/**
 * 像操作员一样回到可以开播的状态：还在输出模式（上一轮没触发急停）时先急停，再切回原场景、取消静音、
 * 确认在场，等开播预检通过。
 */
async function ready(ctx: Context, timeoutMs: number): Promise<void> {
  if ((await ctx.call(OperatorMethod.Status)).mode !== 'safe-stop')
    await ctx.call(OperatorMethod.EmergencyStop, { reason: '演练：复位' });
  ok(await ctx.obs.request('SetCurrentProgramScene', { sceneName: ctx.liveScene }));
  ok(await ctx.obs.request('SetInputMute', { inputName: ctx.stageSource, inputMuted: false }));
  await ctx.call(OperatorMethod.Presence);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const failures = (await ctx.call(OperatorMethod.Preflight, { target: 'M2' }))
      .failures as string[];
    if (failures.length === 0) return;
    if (Date.now() > deadline) throw new Error(`开播预检未通过：${failures.join('；')}`);
    await sleep(500);
  }
}

/** 回到可以开播的状态后进入 M2。 */
async function toM2(ctx: Context, timeoutMs: number): Promise<void> {
  await ready(ctx, timeoutMs);
  const m2 = await ctx.call(OperatorMethod.Mode, { target: 'M2' });
  if (m2.ok !== true) throw new Error(`进入 M2 失败：${JSON.stringify(m2)}`);
  // 稳定收发几轮心跳后再制造外部变化。
  await sleep(1000);
}

/** 制造一次外部变化，返回做了什么。没给热键时按轮次交替切场景与静音；both 时两项都做。 */
async function trigger(ctx: Context, index: number, both = false): Promise<string> {
  if (ctx.hotkeys.length > 0) {
    const answers = await Promise.all(
      ctx.hotkeys.map((hotkey) => ctx.obs.request('TriggerHotkeyByName', { ...hotkey })),
    );
    for (const answer of answers) ok(answer);
    return `hotkey:${ctx.hotkeys.map((h) => h.hotkeyName).join('+')}`;
  }
  const scene = () =>
    ctx.obs.request('SetCurrentProgramScene', { sceneName: ctx.safeScene }).then(ok);
  const mute = () =>
    ctx.obs.request('SetInputMute', { inputName: ctx.stageSource, inputMuted: true }).then(ok);
  if (both) {
    await Promise.all([scene(), mute()]);
    return 'scene+mute';
  }
  if (index % 2 === 0) {
    await scene();
    return 'scene';
  }
  await mute();
  return 'mute';
}

async function readObs(ctx: Context) {
  const scene = ok(await ctx.obs.request('GetCurrentProgramScene'));
  const mute = ok(await ctx.obs.request('GetInputMute', { inputName: ctx.stageSource }));
  const name = scene.sceneName ?? scene.currentProgramSceneName;
  return { sceneSafe: name === ctx.safeScene, stageMuted: mute.inputMuted === true };
}

async function hotkeyTrial(ctx: Context, index: number) {
  await toM2(ctx, 30_000);
  const from = ctx.host.items.length;
  const sentAt = Date.now();
  const action = await trigger(ctx, index);
  const completed = await ctx.host.wait(isFact('safety.emergency-completed'), 10_000, from);
  const external = ctx.host.find(isFact('safety.obs-external'), from);
  const requested = ctx.host.find(isFact('safety.emergency-requested'), from);
  const status = await ctx.call(OperatorMethod.Status);
  return {
    action,
    completedMs: Date.parse(completed.t) - sentAt,
    detectedMs: external ? Date.parse(external.t) - sentAt : null,
    external: external?.data ?? null,
    reason: (requested?.data as { reason?: string } | undefined)?.reason ?? null,
    obsOk: (completed.data as { ok?: boolean } | undefined)?.ok ?? null,
    mode: status.mode,
    ...(await readObs(ctx)),
  };
}

async function freezeTrial(
  ctx: Context,
  index: number,
  pid: number,
  freezeMs: number,
  suspender: ChildProcess,
  replies: Lines,
) {
  await toM2(ctx, 30_000);
  const hostFrom = ctx.host.items.length;
  const watchdogFrom = ctx.watchdog.items.length;
  let replyFrom = replies.items.length;
  suspender.stdin?.write(`suspend ${pid}\n`);
  await replies.wait((line) => line.event.startsWith('suspend'), 5000, replyFrom);
  const suspendedAt = Date.now();
  let resumed = false;
  try {
    const action = await trigger(ctx, index, true);
    const triggeredAt = Date.now();
    // 宿主卡住，切场景与静音只能由 OBS 自己完成。
    const observed = await readObs(ctx);
    const verifiedAt = Date.now();
    const watchdogBefore = ctx.watchdog.find(
      (l) => l.event === 'watchdog.acting' && Date.parse(l.t) <= verifiedAt,
      watchdogFrom,
    );
    await sleep(Math.max(0, suspendedAt + freezeMs - Date.now()));
    replyFrom = replies.items.length;
    suspender.stdin?.write(`resume ${pid}\n`);
    await replies.wait((line) => line.event.startsWith('resume'), 5000, replyFrom);
    resumed = true;
    const resumedAt = Date.now();
    const requested = await ctx.host.wait(isFact('safety.emergency-requested'), 10_000, hostFrom);
    // 宿主先读到哪一个：OBS 外部变化还是看门狗的报告（两者都可能在恢复后排队到达）。
    await sleep(1000);
    const facts = ctx.host.items
      .slice(hostFrom)
      .filter((l) => l.event === 'fact')
      .map((l) => String(l.type));
    const firstSource = facts.find((t) => t === 'safety.obs-external' || t === 'watchdog.acted');
    const watchdogActed = ctx.watchdog.find((l) => l.event === 'watchdog.acted', watchdogFrom);
    const status = await ctx.call(OperatorMethod.Status);
    return {
      action,
      triggerAfterSuspendMs: triggeredAt - suspendedAt,
      verifiedAfterTriggerMs: verifiedAt - triggeredAt,
      obsDoneByItself: observed.sceneSafe && observed.stageMuted,
      ...observed,
      watchdogActedBeforeVerify: watchdogBefore !== undefined,
      watchdogActedMs: watchdogActed ? Date.parse(watchdogActed.t) - suspendedAt : null,
      hostEmergencyAfterResumeMs: Date.parse(requested.t) - resumedAt,
      hostFirstSource:
        firstSource === 'safety.obs-external'
          ? 'obs-external'
          : firstSource === 'watchdog.acted'
            ? 'watchdog'
            : null,
      emergencyReason: (requested.data as { reason?: string } | undefined)?.reason ?? null,
      facts: facts.filter((t) =>
        [
          'safety.obs-external',
          'watchdog.acted',
          'safety.emergency-requested',
          'safety.emergency-completed',
        ].includes(t),
      ),
      mode: status.mode,
    };
  } finally {
    if (!resumed) suspender.stdin?.write(`resume ${pid}\n`);
  }
}

async function listHotkeys(): Promise<void> {
  const obs = await connectObs();
  try {
    const names = ok(await obs.request('GetHotkeyList')).hotkeys as string[];
    for (const name of names) console.log(name);
  } finally {
    obs.close();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', default: 'config/live.json' },
      trials: { type: 'string', default: '10' },
      hotkey: { type: 'string', multiple: true, default: [] },
      'freeze-trials': { type: 'string', default: '3' },
      'freeze-ms': { type: 'string', default: '2000' },
      out: { type: 'string' },
      'list-hotkeys': { type: 'boolean', default: false },
    },
  });
  if (values['list-hotkeys']) {
    await listHotkeys();
    return;
  }
  const trials = Number(values.trials);
  const freezeTrials = Number(values['freeze-trials']);
  const freezeMs = Number(values['freeze-ms']);
  if (!(Number.isInteger(trials) && trials >= 1)) throw new Error('--trials 为正整数');
  if (!(Number.isInteger(freezeTrials) && freezeTrials >= 0))
    throw new Error('--freeze-trials 为非负整数');
  if (!(Number.isInteger(freezeMs) && freezeMs >= 500)) throw new Error('--freeze-ms 不小于 500');
  const hotkeys = values.hotkey.map(parseHotkey);
  const configPath = resolve(root, values.config);
  if (!existsSync(configPath))
    throw new Error(
      `找不到配置文件 ${values.config}：从 config/live.example.json 复制一份并按本机填写（不入库）`,
    );
  const config = loadConfig(configPath);
  const { stageSource, safeScene } = config.safety.emergency;
  const started = new Date().toISOString();
  const out = resolve(
    values.out ?? join(root, 'reports', `drill-obs-hotkey-${started.replace(/[:.]/g, '-')}`),
  );
  mkdirSync(dirname(out), { recursive: true });

  await waitForNoOtherBellis({ log: say });
  const obs = await connectObs();
  const log = createWriteStream(`${out}.log`);
  const result: Record<string, unknown> = { config: values.config, hotkeys };
  const results: { hotkey: unknown[]; freeze: unknown[] } = { hotkey: [], freeze: [] };
  let original: ObsSnapshot | undefined;
  let session: Session | undefined;
  let suspender: ChildProcess | undefined;
  try {
    if (ok(await obs.request('GetStreamStatus')).outputActive)
      throw new Error('推流进行中，拒绝运行');
    result.obsVersion = ok(await obs.request('GetVersion')).obsVersion;
    original = await snapshot(obs, stageSource, safeScene);
    if (!original.scenes.includes(safeScene)) throw new Error(`OBS 中没有安全场景「${safeScene}」`);
    if (!original.inputs.includes(stageSource))
      throw new Error(`OBS 中没有 Stage 源「${stageSource}」`);
    if (original.programScene === safeScene)
      throw new Error('节目场景已经是安全场景：先切回直播场景再运行，演练结束后会切回它');
    const liveScene = original.programScene;
    if (hotkeys.length > 0) {
      const names = ok(await obs.request('GetHotkeyList')).hotkeys as string[];
      const missing = hotkeys.filter((h) => !names.includes(h.hotkeyName));
      if (missing.length > 0)
        throw new Error(
          `OBS 里没有热键 ${missing.map((h) => h.hotkeyName).join('、')}（--list-hotkeys 列出全部）`,
        );
    }

    session = await launch({
      configPath,
      secretService: 'bellis',
      host: { command: process.execPath, args: [hostMain] },
      watchdog: { command: process.execPath, args: [watchdogMain] },
      stdout: 'pipe',
    });
    const host = new Lines(session.host.stdout, (line) => log.write(`host ${line}\n`));
    const watchdog = new Lines(session.watchdog.stdout, (line) => log.write(`watchdog ${line}\n`));
    const key = decodeSessionKey(session.info.channelKey);
    const operator = new RpcPeer(await connect(session.info.channelPath, Role.Operator, { key }), {
      timeoutMs: 10_000,
    });
    const ctx: Context = {
      obs,
      stageSource,
      safeScene,
      liveScene,
      hotkeys,
      host,
      watchdog,
      call: (method, params = {}) =>
        operator.request(method, params) as Promise<Record<string, unknown>>,
    };
    await host.wait((l) => l.event === 'host.ready', 120_000);
    await host.wait((l) => l.event === 'stage-page.authenticated', 60_000);
    await watchdog.wait((l) => l.event === 'watchdog.obs-connected', 30_000);
    // 第一次等开播预检通过：本地 TTS 等可能还在加载，多等一会儿。
    await ready(ctx, 240_000);

    for (let index = 0; index < trials; index++) {
      const trial = await hotkeyTrial(ctx, index).catch((error: Error) => ({
        error: error.message,
      }));
      results.hotkey.push(trial);
      say(`外部变化 #${index + 1}：${JSON.stringify(trial)}`);
    }

    if (freezeTrials > 0 && process.platform !== 'win32') {
      result.freezeSkipped = '挂起宿主进程只在 Windows 上实现（NtSuspendProcess）';
    } else if (freezeTrials > 0) {
      suspender = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', SUSPENDER],
        {
          stdio: ['pipe', 'pipe', 'inherit'],
          windowsHide: true,
        },
      );
      const replies = new Lines(suspender.stdout, undefined, true);
      await replies.wait((line) => line.event === 'ready', 30_000);
      for (let index = 0; index < freezeTrials; index++) {
        const trial = await freezeTrial(
          ctx,
          index,
          session.host.pid,
          freezeMs,
          suspender,
          replies,
        ).catch((error: Error) => ({ error: error.message }));
        results.freeze.push(trial);
        say(`宿主卡死 #${index + 1}：${JSON.stringify(trial)}`);
      }
    }
    operator.connection.close();
  } catch (error) {
    result.error = (error as Error).stack ?? String(error);
    say(`演练中止：${(error as Error).message}`);
  } finally {
    suspender?.stdin?.end();
    await session?.stop().catch(() => undefined);
    await new Promise<void>((done) => log.end(done));
    if (original) {
      const steps = await restoreSnapshot(obs, original, stageSource);
      const diffs = differences(original, await snapshot(obs, stageSource, safeScene));
      result.obsRestored = { ok: steps.length === 0 && diffs.length === 0, steps, diffs };
      say(`OBS 恢复：${JSON.stringify(result.obsRestored)}`);
    }
    obs.close();
  }

  const numbers = (rows: unknown[], field: string) =>
    rows
      .map((r) => (r as Record<string, unknown>)[field])
      .filter((v): v is number => typeof v === 'number');
  const failed = (rows: unknown[]) => rows.filter((r) => 'error' in (r as object)).length;
  const summary = {
    hotkey: {
      failed: failed(results.hotkey),
      allSafe: results.hotkey.every((r) => {
        const x = r as Record<string, unknown>;
        return x.mode === 'safe-stop' && x.sceneSafe === true && x.stageMuted === true;
      }),
      completedMs: summarize(numbers(results.hotkey, 'completedMs')),
      detectedMs: summarize(numbers(results.hotkey, 'detectedMs')),
    },
    freeze: {
      failed: failed(results.freeze),
      obsDoneByItself: results.freeze.filter(
        (r) => (r as Record<string, unknown>).obsDoneByItself === true,
      ).length,
      hostSafeAfterResume: results.freeze.filter(
        (r) => (r as Record<string, unknown>).mode === 'safe-stop',
      ).length,
      hostFirstSource: results.freeze.map((r) => (r as Record<string, unknown>).hostFirstSource),
      hostEmergencyAfterResumeMs: summarize(numbers(results.freeze, 'hostEmergencyAfterResumeMs')),
    },
  };
  writeFileSync(
    `${out}.json`,
    `${JSON.stringify({ drill: 'obs-hotkey', started, finished: new Date().toISOString(), node: process.version, stageSource, safeScene, ...result, summary, results }, null, 2)}\n`,
  );
  console.log(JSON.stringify(summary, null, 2));
  say(`结果已写入 ${out}.json，日志 ${out}.log`);
}

try {
  await main();
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
