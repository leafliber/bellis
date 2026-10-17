/**
 * 探针 S-05 的 sidecar 部分：本地 TTS sidecar 被归为 EcoQoS 前后的推理时延（见 docs/plan/spikes.md）。
 *
 *   node spikes/s05-sidecar.ts [--speaker vivian] [--rounds 4] [--warmup 2]
 *                              [--conditions default,eco,high] [--spawned] [--out 结果文件]
 *
 * 装配同 S-07 本地部分（spikes/s07-tts-local.ts）：插件内核在本进程里运行，只装本地 TTS 条目（qwen3 后端），
 * 直接测 `tts.local@1`。sidecar 因此经 `tts-local` 代理插件、按宿主的方式拉起（spawn、windowsHide、
 * 不用 shell；venv 的 python.exe 启动器再拉起真正的解释器），测量点与 S-07 一致，结果可以对照。
 *
 * 条件只作用于 sidecar 的这两个进程，用 SetProcessInformation(ProcessPowerThrottling)：
 *   default  不改设置。第一个 default 块之前从未设置过；之后的 default 块用 ControlMask=0、StateMask=0
 *            交还系统管理（文档中“让系统管理全部节流”的写法），两者分开汇总。
 *   eco      显式开启 EcoQoS：ControlMask=StateMask=PROCESS_POWER_THROTTLING_EXECUTION_SPEED。
 *   high     显式关闭（HighQoS）：ControlMask=EXECUTION_SPEED、StateMask=0。
 * 每轮把每种条件各测一遍固定短句（5 句），各轮的条件顺序轮换，以抵消温度与后台负载的漂移。
 * 每次设置后、每句前后都用 GetProcessInformation(ProcessPowerThrottling) 读回两个进程的状态。
 * 注意：读回的只是显式设置的状态；没有显式设置时为 0/0，系统按启发式推断的 QoS 级别不经这个接口暴露。
 *
 * 每句记：提交到首个 PCM（qwen-tts 不流式，即整句生成时间）、实时率（提交到最后一帧 / 音频时长）、
 * 对齐耗时（最后一帧到流结束：强制对齐、tts.words 与应答）、两个进程在这一句上用的 CPU 时间、
 * 这一句期间各逻辑处理器的忙碌时间按 P 核 / E 核（GetSystemCpuSetInformation 的 EfficiencyClass）分开，
 * 以及 GPU 利用率与 SM 频率的均值（nvidia-smi 每 200ms 一次）。
 *
 * 并发：测量前与每个块之前查别的 Bellis 启动器、宿主、看门狗、探针与演练（node 命令行），以及别的 tts_local
 * 进程（python 命令行）；OBS 在运行时经 obs-websocket 只读查询是否在推流或录制（凭据从 SecretStore 读取，
 * 不打印）。有就每 30 秒查一次，最多等 30 分钟，仍有就停下报错。本进程不操作 OBS。
 *
 * --spawned：按启动器拉起宿主的方式（spawn、windowsHide、不用 shell、stdin 为管道）在子进程里运行整个探针，
 * 看隐藏窗口拉起时缺省条件是否不同。
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createChannelPath, createSessionKey, listen } from '@bellis/channel';
import { OBS_SECRET, readObsSecret } from '@bellis/config';
import {
  ChannelHub,
  catalog,
  Kernel,
  type ResolvedEntry,
  SidecarHostService,
  systemClock,
} from '@bellis/kernel';
import { ObsClient, type ObsResult } from '@bellis/obs';
import { SafetyCore, SafetyService, safetyFacade } from '@bellis/safety';
import { KeyringSecretStore } from '@bellis/secret-store';
import { LocalTtsService, localTts, type TtsEngine } from '@bellis/speech';
import { StateStore } from '@bellis/store';

const script = fileURLToPath(import.meta.url);

/** 与 S-07 本地部分相同的固定短句。 */
const SENTENCES = [
  '你好，欢迎来到直播间。',
  '今天我们来玩魔女审判。',
  '这一题我选第二个选项。',
  '谢谢大家的支持，我们继续。',
  '好，那我们开始吧！',
];

type Condition = 'default' | 'eco' | 'high';
const EXECUTION_SPEED = 0x1;
const MASKS: Record<Condition, { control: number; state: number }> = {
  default: { control: 0, state: 0 },
  eco: { control: EXECUTION_SPEED, state: EXECUTION_SPEED },
  high: { control: EXECUTION_SPEED, state: 0 },
};

const POLL_MS = 30_000;
const WAIT_LIMIT_MS = 30 * 60_000;

/**
 * 常驻的 PowerShell：按行读命令，回一行 JSON。
 *   get <pid,…>                    各进程的显式节流状态（ProcessPowerThrottling）、优先级类与累计 CPU 时间
 *   set <control> <state> <pid,…>  SetProcessInformation(ProcessPowerThrottling)
 *   cpusets                        各逻辑处理器的 EfficiencyClass（GetSystemCpuSetInformation）
 *   power                          当前电源计划与电源模式（PowerGetEffectiveOverlayScheme），只读
 * P/Invoke 都在 C# 里完成，Win32 错误码在调用后立即取得。
 */
const POWER = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -Namespace S05 -Name Power -MemberDefinition @'
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct Throttling { public uint Version; public uint ControlMask; public uint StateMask; }
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
static extern bool GetProcessInformation(System.IntPtr process, int infoClass, ref Throttling info, int size);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
static extern bool SetProcessInformation(System.IntPtr process, int infoClass, ref Throttling info, int size);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
static extern bool GetSystemCpuSetInformation(System.IntPtr information, int length, out int returned, System.IntPtr process, int flags);
const int ProcessPowerThrottling = 4;
public static long[] Get(System.IntPtr process) {
  Throttling s = new Throttling();
  s.Version = 1;
  bool ok = GetProcessInformation(process, ProcessPowerThrottling, ref s, System.Runtime.InteropServices.Marshal.SizeOf(typeof(Throttling)));
  int error = ok ? 0 : System.Runtime.InteropServices.Marshal.GetLastWin32Error();
  return new long[] { ok ? 1 : 0, error, s.ControlMask, s.StateMask };
}
public static long[] Set(System.IntPtr process, uint control, uint state) {
  Throttling s = new Throttling();
  s.Version = 1;
  s.ControlMask = control;
  s.StateMask = state;
  bool ok = SetProcessInformation(process, ProcessPowerThrottling, ref s, System.Runtime.InteropServices.Marshal.SizeOf(typeof(Throttling)));
  int error = ok ? 0 : System.Runtime.InteropServices.Marshal.GetLastWin32Error();
  return new long[] { ok ? 1 : 0, error };
}
public static int[] EfficiencyClasses() {
  int needed;
  GetSystemCpuSetInformation(System.IntPtr.Zero, 0, out needed, System.IntPtr.Zero, 0);
  System.IntPtr buffer = System.Runtime.InteropServices.Marshal.AllocHGlobal(needed);
  try {
    if (!GetSystemCpuSetInformation(buffer, needed, out needed, System.IntPtr.Zero, 0)) return new int[0];
    System.Collections.Generic.List<int> pairs = new System.Collections.Generic.List<int>();
    int offset = 0;
    while (offset < needed) {
      int size = System.Runtime.InteropServices.Marshal.ReadInt32(buffer, offset);
      int type = System.Runtime.InteropServices.Marshal.ReadInt32(buffer, offset + 4);
      if (type == 0) {
        int group = System.Runtime.InteropServices.Marshal.ReadInt16(buffer, offset + 12);
        int logical = System.Runtime.InteropServices.Marshal.ReadByte(buffer, offset + 14);
        pairs.Add(group * 64 + logical);
        pairs.Add(System.Runtime.InteropServices.Marshal.ReadByte(buffer, offset + 18));
      }
      if (size <= 0) break;
      offset += size;
    }
    return pairs.ToArray();
  } finally {
    System.Runtime.InteropServices.Marshal.FreeHGlobal(buffer);
  }
}
[System.Runtime.InteropServices.DllImport("powrprof.dll")]
static extern uint PowerGetEffectiveOverlayScheme(out System.Guid overlay);
public static string Overlay() {
  System.Guid overlay;
  uint result = PowerGetEffectiveOverlayScheme(out overlay);
  return result == 0 ? overlay.ToString() : "failed " + result;
}
'@
function Read-State([int]$id) {
  $p = [System.Diagnostics.Process]::GetProcessById($id)
  try {
    $r = [S05.Power]::Get($p.Handle)
    [ordered]@{ pid = $id; name = $p.ProcessName; path = $p.Path; ok = ($r[0] -eq 1); error = $r[1]; controlMask = $r[2]; stateMask = $r[3]; priorityClass = [string]$p.PriorityClass; cpuMs = $p.TotalProcessorTime.TotalMilliseconds }
  } finally { $p.Dispose() }
}
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $parts = $line.Split(' ')
  try {
    if ($parts[0] -eq 'get') {
      $reply = @(foreach ($id in $parts[1].Split(',')) { Read-State ([int]$id) })
    } elseif ($parts[0] -eq 'set') {
      $reply = @(foreach ($id in $parts[3].Split(',')) {
        $p = [System.Diagnostics.Process]::GetProcessById([int]$id)
        try {
          $r = [S05.Power]::Set($p.Handle, [uint32]$parts[1], [uint32]$parts[2])
          [ordered]@{ pid = [int]$id; ok = ($r[0] -eq 1); error = $r[1] }
        } finally { $p.Dispose() }
      })
    } elseif ($parts[0] -eq 'cpusets') {
      $pairs = [S05.Power]::EfficiencyClasses()
      $reply = @(for ($i = 0; $i -lt $pairs.Length; $i += 2) { [ordered]@{ logical = $pairs[$i]; efficiencyClass = $pairs[$i + 1] } })
    } elseif ($parts[0] -eq 'power') {
      [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
      $scheme = (powercfg /getactivescheme) -join ' '
      $reply = [ordered]@{ activeScheme = $scheme.Trim(); effectiveOverlay = [S05.Power]::Overlay() }
    } else {
      $reply = [ordered]@{ error = "unknown command" }
    }
  } catch {
    $reply = [ordered]@{ error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $reply -Compress -Depth 4))
  [Console]::Out.Flush()
}
`;

interface ProcessState {
  pid: number;
  name: string;
  path: string | null;
  ok: boolean;
  error: number;
  controlMask: number;
  stateMask: number;
  priorityClass: string;
  cpuMs: number;
}

class Power {
  readonly #child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(POWER, 'utf16le').toString('base64'),
    ],
    { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true },
  );
  readonly #pending: Array<{ done: (value: unknown) => void; fail: (error: Error) => void }> = [];

  constructor() {
    createInterface({ input: this.#child.stdout }).on('line', (line) => {
      const next = this.#pending.shift();
      if (!next) return;
      try {
        next.done(JSON.parse(line));
      } catch {
        next.fail(new Error(`节流助手的输出不是 JSON：${line}`));
      }
    });
    this.#child.once('exit', (code) => {
      for (const p of this.#pending.splice(0)) p.fail(new Error(`节流助手已退出：${code}`));
    });
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  async #call(command: string): Promise<unknown> {
    const reply = await new Promise((done, fail) => {
      this.#pending.push({ done, fail });
      this.#child.stdin.write(`${command}\n`);
    });
    if (reply !== null && typeof reply === 'object' && !Array.isArray(reply) && 'error' in reply)
      throw new Error(`节流助手：${String(reply.error)}`);
    return reply;
  }

  async get(pids: readonly number[]): Promise<ProcessState[]> {
    return (await this.#call(`get ${pids.join(',')}`)) as ProcessState[];
  }

  async set(pids: readonly number[], control: number, state: number) {
    return (await this.#call(`set ${control} ${state} ${pids.join(',')}`)) as Array<{
      pid: number;
      ok: boolean;
      error: number;
    }>;
  }

  async cpuSets() {
    return (await this.#call('cpusets')) as Array<{ logical: number; efficiencyClass: number }>;
  }

  async power() {
    return (await this.#call('power')) as { activeScheme: string; effectiveOverlay: string };
  }

  close(): void {
    this.#child.stdin.end();
  }
}

function stats(values: readonly number[], digits = 1) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const round = (v: number | undefined) =>
    v === undefined ? null : Math.round(v * 10 ** digits) / 10 ** digits;
  // 最近秩法：第 ceil(q·n) 个。
  const rank = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
  const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : undefined;
  return {
    n: sorted.length,
    min: round(sorted[0]),
    p50: round(rank(0.5)),
    p95: round(rank(0.95)),
    max: round(sorted.at(-1)),
    mean: round(mean),
  };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function until(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`${what}未在 ${timeoutMs}ms 内发生`);
    await sleep(20);
  }
}

function powershell(command: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

interface Proc {
  pid: number;
  ppid: number;
  name: string;
  commandLine: string;
  path: string;
}

function processTable(): Proc[] {
  const out = powershell(
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath | ConvertTo-Json -Compress',
  );
  const parsed = JSON.parse(out) as Array<{
    ProcessId: number;
    ParentProcessId: number;
    Name: string;
    CommandLine: string | null;
    ExecutablePath: string | null;
  }>;
  return parsed.map((p) => ({
    pid: p.ProcessId,
    ppid: p.ParentProcessId,
    name: p.Name,
    commandLine: p.CommandLine ?? '',
    path: p.ExecutablePath ?? '',
  }));
}

/** 本进程与它的后代（自己拉起的 sidecar、助手进程等），以及 --spawned 时拉起它的探针父进程。 */
function ownPids(table: readonly Proc[]): Set<number> {
  const descendants = new Set([process.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of table) {
      if (!descendants.has(p.pid) && p.ppid !== 0 && descendants.has(p.ppid)) {
        descendants.add(p.pid);
        grew = true;
      }
    }
  }
  const self = table.find((p) => p.pid === process.pid);
  const parent = table.find((p) => p.pid === self?.ppid);
  if (parent && /s05-sidecar/.test(parent.commandLine)) descendants.add(parent.pid);
  return descendants;
}

/** 仓库根（主检出），用来识别命令行里带仓库路径的进程；worktree 里也指向主检出。 */
function repoRoot(): string {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  return dirname(common);
}

const BLOCKING_NODE =
  /packages[\\/](launcher|host|watchdog)[\\/]src[\\/]main\.ts|spikes[\\/](drill-[\w-]+|s\d\d-[\w-]+|s01-stage[\\/]server)\.ts/i;
const TTS_LOCAL = /-m\s+tts_local\b/;

interface Load {
  at: string;
  /** 须等它结束的进程：别的启动器、宿主、看门狗、探针与演练，别的 tts_local。 */
  blocking: Array<{ pid: number; name: string; commandLine: string }>;
  /** 其余命令行带仓库路径的 node/python 进程（例如别处的测试），只记录。 */
  otherRepoProcesses: Array<{ pid: number; name: string; commandLine: string }>;
  obs: { running: boolean; streaming?: boolean; recording?: boolean };
}

function obsOk(result: ObsResult): Record<string, unknown> {
  if (!result.ok)
    throw new Error(`${result.requestType} 失败：${result.code} ${result.comment ?? ''}`);
  return result.data ?? {};
}

async function checkLoad(root: string): Promise<Load> {
  const table = processTable();
  const own = ownPids(table);
  const normalize = (text: string) => text.replaceAll('\\', '/').toLowerCase();
  const repo = normalize(root);
  const blocking: Load['blocking'] = [];
  const otherRepo: Load['otherRepoProcesses'] = [];
  for (const p of table) {
    if (own.has(p.pid)) continue;
    const node = /^node\.exe$/i.test(p.name);
    const python = /^python(w)?\.exe$/i.test(p.name);
    if (!node && !python) continue;
    const item = { pid: p.pid, name: p.name, commandLine: p.commandLine };
    if ((node && BLOCKING_NODE.test(p.commandLine)) || (python && TTS_LOCAL.test(p.commandLine)))
      blocking.push(item);
    else if (normalize(p.commandLine).includes(repo)) otherRepo.push(item);
  }
  const obsRunning = table.some((p) => /^obs64\.exe$/i.test(p.name));
  let obs: Load['obs'] = { running: obsRunning };
  if (obsRunning) {
    const secret = await readObsSecret(
      new KeyringSecretStore(process.env.BELLIS_SECRET_SERVICE ?? 'bellis'),
      OBS_SECRET,
    );
    const client = await ObsClient.connect(secret.url, secret.password);
    try {
      obs = {
        running: true,
        streaming: obsOk(await client.request('GetStreamStatus')).outputActive === true,
        recording: obsOk(await client.request('GetRecordStatus')).outputActive === true,
      };
    } finally {
      client.close();
    }
  }
  return {
    at: new Date().toISOString(),
    blocking,
    otherRepoProcesses: otherRepo,
    obs,
  };
}

function busy(load: Load): string | undefined {
  const reasons = [
    ...load.blocking.map((p) => `${p.pid} ${p.name}: ${p.commandLine}`),
    ...(load.obs.streaming ? ['OBS 在推流'] : []),
    ...(load.obs.recording ? ['OBS 在录制'] : []),
  ];
  return reasons.length ? reasons.join('\n') : undefined;
}

/** 等到没有须等待的负载：每 30 秒查一次，最多 30 分钟，仍有就抛错。 */
async function waitForQuiet(root: string): Promise<{ load: Load; waitedMs: number }> {
  const started = Date.now();
  for (;;) {
    const load = await checkLoad(root);
    const reason = busy(load);
    if (!reason) return { load, waitedMs: Date.now() - started };
    if (Date.now() - started + POLL_MS > WAIT_LIMIT_MS)
      throw new Error(`等了 30 分钟仍有别的负载：\n${reason}`);
    console.log(`有别的负载，${POLL_MS / 1000} 秒后再查：\n${reason}`);
    await sleep(POLL_MS);
  }
}

/** 机器上 CPU 占用最高的进程（只记名字与 pid）。 */
function topCpu(): unknown {
  try {
    return JSON.parse(
      powershell(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } | Sort-Object PercentProcessorTime -Descending | Select-Object -First 8 Name,IDProcess,PercentProcessorTime | ConvertTo-Json -Compress",
      ),
    );
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function gpuApps(): unknown {
  try {
    return execFileSync(
      'nvidia-smi',
      ['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader'],
      { encoding: 'utf8', windowsHide: true },
    )
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function gpuName(): string {
  try {
    return execFileSync(
      'nvidia-smi',
      ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'],
      { encoding: 'utf8', windowsHide: true },
    ).trim();
  } catch (error) {
    return `nvidia-smi 失败：${(error as Error).message}`;
  }
}

/** GPU 利用率、SM 频率与已用显存，每 200ms 一次，带本进程的单调时间戳。 */
function watchGpu() {
  const samples: Array<{ at: number; util: number; smMHz: number; memMiB: number }> = [];
  const child = spawn(
    'nvidia-smi',
    [
      '--query-gpu=utilization.gpu,clocks.sm,memory.used',
      '--format=csv,noheader,nounits',
      '-lms',
      '200',
    ],
    { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
  );
  let rest = '';
  child.stdout.on('data', (chunk: Buffer) => {
    const lines = (rest + chunk.toString('utf8')).split(/\r?\n/);
    rest = lines.pop() ?? '';
    for (const line of lines) {
      const [util, sm, mem] = line.split(',').map((v) => Number(v.trim()));
      if ([util, sm, mem].every((v) => Number.isFinite(v)))
        samples.push({ at: performance.now(), util: util ?? 0, smMHz: sm ?? 0, memMiB: mem ?? 0 });
    }
  });
  const between = (from: number, to: number) => {
    const inside = samples.filter((s) => s.at >= from && s.at <= to);
    if (!inside.length) return { n: 0, utilMean: null, smMHzMean: null };
    const mean = (pick: (s: (typeof inside)[number]) => number) =>
      Math.round(inside.reduce((a, s) => a + pick(s), 0) / inside.length);
    return { n: inside.length, utilMean: mean((s) => s.util), smMHzMean: mean((s) => s.smMHz) };
  };
  return { samples, between, stop: () => child.kill() };
}

/** 各逻辑处理器的累计忙碌时间（ms），用于按 P 核 / E 核分开统计。 */
function busyTimes(): number[] {
  return cpus().map((c) => c.times.user + c.times.nice + c.times.sys + c.times.irq);
}

function entry(id: string, plugin: string, config: unknown = {}): ResolvedEntry {
  return { id, plugin, config, disabled: false, explicitSwitch: false, grant: [] };
}

interface Sample {
  text: string;
  chars: number;
  firstPcmMs: number | null;
  lastPcmMs: number | null;
  endMs: number;
  alignMs: number | null;
  audioMs: number;
  realTimeFactor: number | null;
  /** 两个 sidecar 进程在这一句上用的 CPU 时间之和（含少量测量间隙）。 */
  sidecarCpuMs: number;
  /** 这一句期间整机 P 核与 E 核的忙碌时间（含其它进程）。 */
  pCoreBusyMs: number;
  eCoreBusyMs: number;
  gpu: { n: number; utilMean: number | null; smMHzMean: number | null };
  throttlingBefore: Array<{ pid: number; controlMask: number; stateMask: number }>;
  throttlingAfter: Array<{ pid: number; controlMask: number; stateMask: number }>;
}

function masks(states: readonly ProcessState[]) {
  return states.map((s) => ({ pid: s.pid, controlMask: s.controlMask, stateMask: s.stateMask }));
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      speaker: { type: 'string', default: 'vivian' },
      rounds: { type: 'string', default: '4' },
      warmup: { type: 'string', default: '2' },
      conditions: { type: 'string', default: 'default,eco,high' },
      spawned: { type: 'boolean', default: false },
      'as-child': { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  });
  if (process.platform !== 'win32') throw new Error('只在 Windows 上运行');
  const started = new Date().toISOString();
  const tag = values.spawned || values['as-child'] ? 'spawned' : 'direct';
  const out = resolve(
    values.out ?? join('reports', `S-05-sidecar-${started.slice(0, 10)}-${tag}.json`),
  );
  if (values.spawned) {
    // 按启动器拉起宿主的方式运行整个探针（packages/launcher 的 launch() 经 ManagedProcess）。
    const args = [
      ...['--speaker', values.speaker, '--rounds', values.rounds, '--warmup', values.warmup],
      ...['--conditions', values.conditions, '--out', out, '--as-child'],
    ];
    const child = spawn(process.execPath, [...process.execArgv, script, ...args], {
      stdio: ['pipe', 'inherit', 'inherit'],
      windowsHide: true,
      shell: false,
      detached: false,
    });
    const code = await new Promise<number | null>((done) => child.once('exit', done));
    process.exitCode = code ?? 1;
    return;
  }
  const conditions = values.conditions.split(',') as Condition[];
  for (const c of conditions) if (!(c in MASKS)) throw new Error(`未知条件 ${c}`);
  const rounds = Number(values.rounds);
  const warmupCount = Number(values.warmup);
  mkdirSync(dirname(out), { recursive: true });
  const root = repoRoot();

  const power = new Power();
  const cpuSets = await power.cpuSets();
  const classes = new Map(cpuSets.map((c) => [c.logical, c.efficiencyClass]));
  const topClass = Math.max(...cpuSets.map((c) => c.efficiencyClass));
  const isPCore = (i: number) => classes.get(i) === topClass && topClass > 0;
  const probeState = await power.get([process.pid]);
  const powerBefore = await power.power();
  console.log('电源：', JSON.stringify(powerBefore));

  const first = await waitForQuiet(root);
  console.log('负载：', JSON.stringify(first.load));
  const loadBefore = { ...first, topCpu: topCpu(), gpuApps: gpuApps() };

  const logs: Array<{ at: number; event: string; fields: Record<string, unknown> }> = [];
  const t0 = performance.now();
  const store = StateStore.open({ path: ':memory:' });
  store.recover();
  const clock = systemClock();
  let kernel: Kernel | undefined;
  const safety = new SafetyCore({
    store,
    clock,
    config: {
      simulation: true,
      leaseTtlMs: {},
      leaseCapabilities: {},
      presenceTtlMs: 60_000,
      rateLimits: {},
      guardTimeoutMs: 200,
      emergency: { stageSource: 'Stage', safeScene: 'Safe', stopStream: false },
      unattendedGatesSatisfied: false,
    },
    obs: { ready: false, run: async () => ({ ok: false, results: [] }) },
    permissionsOf: (holder) => kernel?.permissionsOf(holder),
    watchdogConnected: () => false,
  });
  const host = new Kernel({
    clock,
    safety: safety.kernelHooks(),
    log: (event, fields) => logs.push({ at: Math.round(performance.now() - t0), event, fields }),
  });
  kernel = host;
  host.provideScoped(SafetyService, ({ instanceId }) => safetyFacade(safety, instanceId));
  const credentials = {
    path: createChannelPath(`s05${randomBytes(3).toString('hex')}`),
    key: createSessionKey(),
  };
  const hub = new ChannelHub();
  const server = await listen(credentials.path, {
    key: credentials.key,
    onConnection: (connection) => hub.accept(connection),
    onRejected: () => {},
    onError: (error) => console.error(error),
  });
  host.provideCore(SidecarHostService, { credentials, hub });
  const engine = () => {
    const found = host.services.resolve(LocalTtsService.name, LocalTtsService.major);
    return 'missing' in found ? undefined : (found.impl as TtsEngine);
  };
  const degraded = () => store.events().some((e) => e.type === 'tts.degraded');

  const gpu = watchGpu();
  await sleep(1500);
  const gpuIdleBefore = gpu.between(0, performance.now());
  const tStart = performance.now();
  host.add(
    [
      entry('tts-local', 'tts-local', {
        backend: 'qwen3',
        qwen3: { speaker: values.speaker, language: 'chinese' },
        // EcoQoS 下一句可能慢得多，放宽截止时间，避免把慢当成失败。
        synthesizeTimeoutMs: 300_000,
      }),
    ],
    catalog(localTts),
  );
  await host.settled();
  await until(() => engine()?.ready === true || degraded(), 300_000, '模型就绪');
  const local = engine();
  if (!local?.ready) {
    console.error(JSON.stringify({ snapshot: host.snapshot(), logs }, null, 2));
    throw new Error(`模型未就绪：${local?.status ?? '本地引擎不在'}`);
  }
  const readyMs = Math.round(performance.now() - tStart);
  const ready = logs.filter((l) => l.event === 'tts-local.ready').at(-1);
  const launcherPid = Number((ready?.fields as { pid?: number } | undefined)?.pid);
  const table = processTable();
  const interpreters = table.filter((p) => p.ppid === launcherPid);
  const grandchildren = table.filter((p) => interpreters.some((i) => i.pid === p.ppid));
  if (interpreters.length !== 1)
    throw new Error(`venv 启动器的子进程不是一个：${interpreters.length}`);
  const pids = [launcherPid, (interpreters[0] as Proc).pid];
  const processes = {
    launcher: table.find((p) => p.pid === launcherPid),
    interpreter: interpreters[0],
    grandchildren,
  };
  console.log(`模型就绪 ${readyMs}ms；sidecar 进程 ${pids.join('、')}`);
  const pristine = await power.get(pids);
  console.log('未设置时读回：', JSON.stringify(masks(pristine)));

  const measure = async (text: string): Promise<Sample> => {
    const before = await power.get(pids);
    const cpuBefore = busyTimes();
    const abort = new AbortController();
    const t = performance.now();
    const synthesis = await local.synthesize(text, abort.signal);
    let firstAt: number | undefined;
    let lastAt: number | undefined;
    let samples = 0;
    for await (const frame of synthesis.frames) {
      const now = performance.now();
      firstAt ??= now;
      lastAt = now;
      samples += frame.length;
    }
    const end = performance.now();
    const cpuAfter = busyTimes();
    const after = await power.get(pids);
    let pBusy = 0;
    let eBusy = 0;
    cpuAfter.forEach((v, i) => {
      const d = v - (cpuBefore[i] ?? v);
      if (isPCore(i)) pBusy += d;
      else eBusy += d;
    });
    const audioMs = (samples * 1000) / synthesis.sampleRate;
    const round = (v: number) => Math.round(v * 10) / 10;
    const cpuOf = (states: readonly ProcessState[]) => states.reduce((a, s) => a + s.cpuMs, 0);
    return {
      text,
      chars: [...text].length,
      firstPcmMs: firstAt === undefined ? null : round(firstAt - t),
      lastPcmMs: lastAt === undefined ? null : round(lastAt - t),
      endMs: round(end - t),
      alignMs: lastAt === undefined ? null : round(end - lastAt),
      audioMs: round(audioMs),
      realTimeFactor:
        lastAt === undefined || audioMs === 0
          ? null
          : Math.round(((lastAt - t) / audioMs) * 1000) / 1000,
      sidecarCpuMs: Math.round(cpuOf(after) - cpuOf(before)),
      pCoreBusyMs: Math.round(pBusy),
      eCoreBusyMs: Math.round(eBusy),
      gpu: gpu.between(t, end),
      throttlingBefore: masks(before),
      throttlingAfter: masks(after),
    };
  };

  // 热身：就绪后的头几句（第一句为冷），都在从未设置的缺省条件下，不计入。
  const warmup: Sample[] = [];
  for (let i = 0; i < warmupCount; i++) {
    const m = await measure(SENTENCES[i % SENTENCES.length] as string);
    warmup.push(m);
    console.log(`热身：首个 PCM ${m.firstPcmMs}ms，实时率 ${m.realTimeFactor}`);
  }

  const blocks: Array<Record<string, unknown> & { condition: Condition; samples: Sample[] }> = [];
  let everSet = false;
  for (let r = 0; r < rounds; r++) {
    const order = conditions.map((_, i) => conditions[(i + r) % conditions.length] as Condition);
    for (const condition of order) {
      const quiet = await waitForQuiet(root);
      // 每个块前的空闲窗口：整机 CPU 与 GPU 的背景占用（sidecar 空闲）。
      const idleFrom = performance.now();
      const idleCpu0 = busyTimes();
      await sleep(2000);
      const idleCpu1 = busyTimes();
      const idleTo = performance.now();
      const backgroundCpuPercent =
        Math.round(
          (idleCpu1.reduce((a, v, i) => a + v - (idleCpu0[i] ?? v), 0) /
            ((idleTo - idleFrom) * idleCpu1.length)) *
            1000,
        ) / 10;
      const pristineBlock = condition === 'default' && !everSet;
      let set: unknown = null;
      if (!pristineBlock) {
        const { control, state } = MASKS[condition];
        set = await power.set(pids, control, state);
        everSet = true;
      }
      const readBack = await power.get(pids);
      const expected = MASKS[condition];
      const applied = readBack.every(
        (s) => s.ok && s.controlMask === expected.control && s.stateMask === expected.state,
      );
      if (!applied) throw new Error(`读回与设置不符：${JSON.stringify(readBack)}`);
      console.log(
        `第 ${r + 1} 轮 ${condition}${pristineBlock ? '（从未设置）' : ''}：读回 ${JSON.stringify(masks(readBack))}，背景 CPU ${backgroundCpuPercent}%`,
      );
      const samples: Sample[] = [];
      for (const text of SENTENCES) {
        const m = await measure(text);
        samples.push(m);
        console.log(
          `  ${text} 首个 PCM ${m.firstPcmMs}ms，实时率 ${m.realTimeFactor}，对齐 ${m.alignMs}ms，CPU ${m.sidecarCpuMs}ms，E 核 ${m.eCoreBusyMs}ms / P 核 ${m.pCoreBusyMs}ms`,
        );
      }
      blocks.push({
        round: r + 1,
        condition,
        pristine: pristineBlock,
        load: quiet.load,
        waitedMs: quiet.waitedMs,
        backgroundCpuPercent,
        backgroundGpu: gpu.between(idleFrom, idleTo),
        set,
        readBack,
        samples,
      });
    }
  }

  const loadAfter = { load: await checkLoad(root), topCpu: topCpu(), gpuApps: gpuApps() };
  const powerAfter = await power.power();
  gpu.stop();
  await host.shutdown();
  await server.close();
  store.close();
  power.close();

  const summarize = (samples: readonly Sample[]) => {
    const pick = (f: (s: Sample) => number | null, digits = 1) =>
      stats(
        samples.map((s) => f(s) ?? Number.NaN),
        digits,
      );
    const p = samples.reduce((a, s) => a + s.pCoreBusyMs, 0);
    const e = samples.reduce((a, s) => a + s.eCoreBusyMs, 0);
    return {
      firstPcmMs: pick((s) => s.firstPcmMs),
      realTimeFactor: pick((s) => s.realTimeFactor, 3),
      alignMs: pick((s) => s.alignMs),
      endMs: pick((s) => s.endMs),
      sidecarCpuMs: pick((s) => s.sidecarCpuMs, 0),
      /** sidecar CPU 时间占这一句墙钟时间的比例（约等于平均占用的核数）。 */
      sidecarCpuPerWall: pick((s) => s.sidecarCpuMs / s.endMs, 3),
      eCoreShareOfBusy: Math.round((e / Math.max(1, p + e)) * 1000) / 1000,
      gpuUtilMean: pick((s) => s.gpu.utilMean, 0),
      smMHzMean: pick((s) => s.gpu.smMHzMean, 0),
    };
  };
  const of = (filter: (b: (typeof blocks)[number]) => boolean) =>
    blocks.filter(filter).flatMap((b) => b.samples);
  const summary: Record<string, unknown> = {};
  for (const c of conditions) summary[c] = summarize(of((b) => b.condition === c));
  if (conditions.includes('default')) {
    summary.defaultPristine = summarize(
      of((b) => b.condition === 'default' && b.pristine === true),
    );
    summary.defaultReset = summarize(of((b) => b.condition === 'default' && b.pristine !== true));
  }

  writeFileSync(
    out,
    `${JSON.stringify(
      {
        spike: 'S-05',
        part: 'sidecar',
        started,
        finished: new Date().toISOString(),
        spawnedLikeLauncher: values['as-child'],
        node: process.version,
        os: { platform: platform(), release: release(), arch: arch() },
        cpu: { model: cpus()[0]?.model, logical: cpus().length, cpuSets },
        gpu: gpuName(),
        power: { before: powerBefore, after: powerAfter },
        model: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice@85e237c',
        aligner: 'Qwen/Qwen3-ForcedAligner-0.6B@c7cbfc2',
        speaker: values.speaker,
        sentences: SENTENCES,
        rounds,
        warmupCount,
        conditions,
        readyMs,
        processes,
        probeThrottling: probeState,
        helperPid: power.pid,
        pristineThrottling: pristine,
        loadBefore,
        loadAfter,
        gpuIdleBefore,
        summary,
        warmup,
        blocks,
        logs: logs.filter((l) => l.event.startsWith('tts') || l.event.startsWith('sidecar')),
      },
      null,
      2,
    )}\n`,
  );
  console.log(JSON.stringify(summary, null, 2));
  console.log(`结果已写入 ${out}`);
}

await main();
