/**
 * 探针 S-07 的本地部分：Qwen3-TTS（`tts-local` 的 qwen3 后端）在本机 GPU 上的首包、实时率、显存峰值与强制对齐，
 * 以及用真实模型做一次 sidecar 崩溃与恢复演练（见 docs/plan/spikes.md 与 P1 出口的 sidecar 一项）。
 *
 *   node spikes/s07-tts-local.ts [--speaker vivian] [--rounds 2] [--no-drill] [--out 结果文件]
 *
 * 先 `uv sync --locked --group tts-local` 并把模型权重下载到 Hugging Face 缓存（见 docs/modules/speech.md）。
 * 插件内核在本进程里运行，不经启动器、不连 OBS、不碰 SecretStore：本地 TTS 条目加 TTS 路由（local、subtitles）。
 *
 * 测：
 *   1. 冷启动：拉起 sidecar 到握手完成（插件激活）、到模型就绪；
 *   2. 合成：就绪后第一句（冷）与之后各句（热）的提交到首个 PCM、到最后一帧、到流结束（含强制对齐），
 *      音频时长、实时率（提交到最后一帧 / 音频时长），以及细化后与纯插值相差超过 10ms 的码点比例；
 *   3. 取消：合成中途取消，测紧接着下一句的提交到首个 PCM（qwen-tts 不能中断生成，下一句要等它生成完）；
 *   4. 显存：nvidia-smi 每 200ms 读一次整卡已用显存，记基线与峰值，结束时列出各进程占用；
 *   5. 演练（--no-drill 跳过）：强制终止 sidecar，核对记入 tts.degraded、`tts@1` 不消失、路由改为只出字幕、
 *      sidecar 的解释器进程随之退出；按退避重启、模型重新加载就绪后换回本地。记录各步耗时。
 * 运行时有没有别的 Bellis 进程、OBS 是否在运行写进结果（不查询 OBS 的录制状态）；游戏负载另由 S-02 布置。
 * 未覆盖：到 Stage 游标起步的时间（需真实 Stage，随第 10 步演练测）。
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { createChannelPath, createSessionKey, listen } from '@bellis/channel';
import {
  ChannelHub,
  catalog,
  definePlugin,
  Kernel,
  type ResolvedEntry,
  SidecarHostService,
  systemClock,
} from '@bellis/kernel';
import { SafetyCore, SafetyService, safetyFacade } from '@bellis/safety';
import {
  Alignment,
  LocalTtsService,
  localTts,
  type Synthesis,
  type Tts,
  type TtsEngine,
  TtsService,
  ttsRouter,
} from '@bellis/speech';
import { StateStore } from '@bellis/store';
import Type from 'typebox';

const SENTENCES = [
  '你好，欢迎来到直播间。',
  '今天我们来玩魔女审判。',
  '这一题我选第二个选项。',
  '谢谢大家的支持，我们继续。',
  '好，那我们开始吧！',
];
const LONG_SENTENCE =
  '这是一句用来测量取消的长句子，让合成需要持续好几秒钟，我们会在中途把它取消掉。';

function summarize(values: readonly number[]) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const round = (v: number | undefined) => (v === undefined ? null : Math.round(v * 10) / 10);
  return {
    n: sorted.length,
    min: round(sorted[0]),
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted.at(-1)),
  };
}

function wav(pcm: Int16Array, sampleRate: number): Buffer {
  const data = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) data.writeInt16LE(pcm[i] as number, i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function until(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`${what}未在 ${timeoutMs}ms 内发生`);
    await sleep(20);
  }
}

/** 整卡已用显存（MiB），每 200ms 一次。 */
function watchGpu() {
  const samples: number[] = [];
  const child = spawn(
    'nvidia-smi',
    ['--query-gpu=memory.used', '--format=csv,noheader,nounits', '-lms', '200'],
    { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
  );
  let rest = '';
  child.stdout.on('data', (chunk: Buffer) => {
    const lines = (rest + chunk.toString('utf8')).split(/\r?\n/);
    rest = lines.pop() ?? '';
    for (const line of lines) {
      const value = Number(line.trim());
      if (Number.isFinite(value) && line.trim() !== '') samples.push(value);
    }
  });
  return {
    samples,
    peak: () => Math.max(...samples),
    stop: () => child.kill(),
  };
}

function gpuInfo() {
  try {
    const gpu = execFileSync(
      'nvidia-smi',
      ['--query-gpu=name,driver_version,memory.total,memory.used', '--format=csv,noheader'],
      { encoding: 'utf8', windowsHide: true },
    ).trim();
    const apps = execFileSync(
      'nvidia-smi',
      ['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader'],
      { encoding: 'utf8', windowsHide: true },
    ).trim();
    return { gpu, computeApps: apps.split(/\r?\n/).filter(Boolean) };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** Windows：命令行里带 bellis 的 node 进程（启动器、宿主、看门狗等）与 OBS 是否在运行。 */
function environment(): Record<string, unknown> {
  if (process.platform !== 'win32') return { checked: false };
  const script =
    "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'bellis' -and $_.CommandLine -match 'launcher|host[\\\\/]src|watchdog') -or $_.Name -eq 'obs64.exe' } | ForEach-Object { \"$($_.ProcessId) $($_.Name)\" }";
  const lines = execFileSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  })
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    otherBellisProcesses: lines.filter((l) => l.includes('node')),
    obsRunning: lines.some((l) => l.includes('obs64')),
  };
}

/** Windows：某进程的直接子进程。 */
function childrenOf(pid: number): number[] {
  if (process.platform !== 'win32') return [];
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { $_.ProcessId }`,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  return out
    .split(/\r?\n/)
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function entry(id: string, plugin: string, config: unknown = {}): ResolvedEntry {
  return { id, plugin, config, disabled: false, explicitSwitch: false, grant: [] };
}

interface Measured {
  text: string;
  chars: number;
  sampleRate: number;
  submitToFirstPcmMs: number | null;
  submitToLastPcmMs: number | null;
  submitToEndMs: number;
  audioMs: number;
  realTimeFactor: number | null;
  refinedShare: number | null;
  timing: Array<{ sample: number; char: number }> | undefined;
  pcm: Int16Array;
}

async function measure(tts: Tts, text: string, abortAfterMs?: number): Promise<Measured> {
  const abort = new AbortController();
  const started = performance.now();
  const synthesis: Synthesis = await tts.synthesize(text, abort.signal);
  if (abortAfterMs !== undefined)
    setTimeout(() => abort.abort(new Error('探针取消')), abortAfterMs);
  let first: number | undefined;
  let last: number | undefined;
  const chunks: Int16Array[] = [];
  for await (const frame of synthesis.frames) {
    const t = performance.now();
    first ??= t;
    last = t;
    chunks.push(frame);
  }
  const end = performance.now();
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const pcm = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) {
    pcm.set(c, offset);
    offset += c.length;
  }
  const audioMs = (total * 1000) / synthesis.sampleRate;
  const timing = synthesis.timing?.map((t) => ({ ...t }));
  let refinedShare: number | null = null;
  if (timing && synthesis.totalSamples !== undefined) {
    const plain = new Alignment(text, synthesis.sampleRate, { msPerChar: 220 });
    plain.complete(synthesis.totalSamples);
    const tolerance = synthesis.sampleRate / 100;
    const differs = timing.filter(
      (t, i) => Math.abs(t.sample - (plain.timing[i]?.sample ?? t.sample)) > tolerance,
    ).length;
    refinedShare = Math.round((differs / Math.max(1, timing.length)) * 1000) / 1000;
  }
  const round = (v: number) => Math.round(v * 10) / 10;
  return {
    text,
    chars: [...text].length,
    sampleRate: synthesis.sampleRate,
    submitToFirstPcmMs: first === undefined ? null : round(first - started),
    submitToLastPcmMs: last === undefined ? null : round(last - started),
    submitToEndMs: round(end - started),
    audioMs: round(audioMs),
    realTimeFactor:
      last === undefined || audioMs === 0
        ? null
        : Math.round(((last - started) / audioMs) * 1000) / 1000,
    refinedShare,
    timing,
    pcm,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      speaker: { type: 'string', default: 'vivian' },
      rounds: { type: 'string', default: '2' },
      'no-drill': { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  });
  const rounds = Number(values.rounds);
  const started = new Date().toISOString();
  const out = resolve(values.out ?? join('reports', `S-07-local-${started.slice(0, 10)}.json`));
  mkdirSync(dirname(out), { recursive: true });
  const before = environment();
  console.log('运行环境：', JSON.stringify(before));

  const logs: Array<{ at: number; event: string; fields: Record<string, unknown> }> = [];
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
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
  // 缺省的激活时限与退避（与宿主一致）。
  const host = new Kernel({
    clock,
    safety: safety.kernelHooks(),
    log: (event, fields) => logs.push({ at: at(), event, fields }),
  });
  kernel = host;
  host.provideScoped(SafetyService, ({ instanceId }) => safetyFacade(safety, instanceId));
  const credentials = {
    path: createChannelPath(`s07${randomBytes(3).toString('hex')}`),
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
  const users: Tts[] = [];
  const user = definePlugin({
    manifest: {
      id: 'probe-user',
      version: '1.0.0',
      tier: 'ordinary',
      provides: [],
      inject: [TtsService.ref],
      permissions: [],
      process: 'in-process',
      config: Type.Object({}),
    },
    activate(ctx) {
      users.push(ctx.service(TtsService));
    },
  });
  const engine = () => {
    const found = host.services.resolve(LocalTtsService.name, LocalTtsService.major);
    return 'missing' in found ? undefined : (found.impl as TtsEngine);
  };
  const events = (type: string) => store.events().filter((e) => e.type === type);

  const gpu = watchGpu();
  await sleep(600);
  const baselineMiB = Math.min(...gpu.samples);
  const tStart = performance.now();
  host.add(
    [
      entry('tts-local', 'tts-local', {
        backend: 'qwen3',
        qwen3: { speaker: values.speaker, language: 'chinese' },
      }),
      entry('tts', 'tts-router', { order: ['local', 'subtitles'] }),
      entry('user', 'probe-user'),
    ],
    catalog(localTts, ttsRouter, user),
  );
  await host.settled();
  const activatedMs = Math.round(performance.now() - tStart);
  await until(
    () => engine()?.ready === true || events('tts.degraded').length > 0,
    300_000,
    '模型就绪',
  );
  const local = engine();
  if (!local?.ready) {
    const relevant = logs.filter((l) => /^(tts|sidecar|plugin)/.test(l.event));
    console.error(JSON.stringify({ snapshot: host.snapshot(), logs: relevant }, null, 2));
    throw new Error(`模型未就绪：${local?.status ?? '本地引擎不在'}`);
  }
  const readyMs = Math.round(performance.now() - tStart);
  console.log(`插件激活 ${activatedMs}ms，模型就绪 ${readyMs}ms`);

  const cold = await measure(local, SENTENCES[0] as string);
  console.log(`冷：首个 PCM ${cold.submitToFirstPcmMs}ms，实时率 ${cold.realTimeFactor}`);
  writeFileSync(out.replace(/\.json$/, '-cold.wav'), wav(cold.pcm, cold.sampleRate));
  const warm: Measured[] = [];
  for (let r = 0; r < rounds; r++) {
    for (const text of SENTENCES) {
      const m = await measure(local, text);
      warm.push(m);
      console.log(`热：${text} 首个 PCM ${m.submitToFirstPcmMs}ms，实时率 ${m.realTimeFactor}`);
    }
  }
  // 取消：中途取消一句长句，紧接着合成一句短句。
  const canceled = await measure(local, LONG_SENTENCE, 1000);
  const afterCancel = await measure(local, SENTENCES[4] as string);
  console.log(`取消后下一句：首个 PCM ${afterCancel.submitToFirstPcmMs}ms`);
  const peakMiB = gpu.peak();
  const atPeak = gpuInfo();

  let drill: Record<string, unknown> | undefined;
  if (!values['no-drill']) {
    const ready = logs.filter((l) => l.event === 'tts-local.ready');
    const pid = Number((ready.at(-1)?.fields as { pid?: number } | undefined)?.pid);
    const interpreters = childrenOf(pid);
    const tKill = performance.now();
    process.kill(pid, 'SIGKILL');
    await until(() => events('tts.degraded').length > 0, 30_000, 'tts.degraded');
    const degradedMs = Math.round(performance.now() - tKill);
    // 紧接着核对进程已退出（拖久了 Windows 可能把 pid 分给别的进程）。
    const gone = [pid, ...interpreters];
    let exitedMs: number | null = null;
    try {
      await until(() => gone.every((p) => !isAlive(p)), 5000, '进程退出');
      exitedMs = Math.round(performance.now() - tKill);
    } catch {
      exitedMs = null;
    }
    const stillAlive = gone.filter((p) => isAlive(p));
    const tts = users[0] as Tts;
    const subtitles = await tts.synthesize(
      '本地引擎恢复之前只出字幕。',
      new AbortController().signal,
    );
    for await (const _ of subtitles.frames) {
      // 只出字幕的静音帧：读完即可。
    }
    const subtitleRate = subtitles.sampleRate;
    await until(() => engine()?.ready === true, 300_000, '重启后模型就绪');
    const recoveredMs = Math.round(performance.now() - tKill);
    const back = await measure(tts, SENTENCES[1] as string);
    await sleep(500);
    const restarted = logs.filter((l) => l.event === 'tts-local.ready').at(-1);
    drill = {
      killedPid: pid,
      interpreterPids: interpreters,
      killToProcessesExitedMs: exitedMs,
      stillAliveAfter5s: stillAlive,
      restartedPid: (restarted?.fields as { pid?: number } | undefined)?.pid ?? null,
      killToDegradedEventMs: degradedMs,
      routerStateAfterCrash: host.snapshot().find((e) => e.id === 'tts')?.state,
      userStateAfterCrash: host.snapshot().find((e) => e.id === 'user')?.state,
      subtitleSampleRate: subtitleRate,
      killToReadyAgainMs: recoveredMs,
      afterRecovery: { firstPcmMs: back.submitToFirstPcmMs, sampleRate: back.sampleRate },
      events: store
        .events()
        .filter((e) => e.type.startsWith('tts.'))
        .map((e) => ({ type: e.type, data: e.data })),
    };
    console.log(`演练：降级事件 ${degradedMs}ms，重新就绪 ${recoveredMs}ms`);
  }
  gpu.stop();
  await host.shutdown();
  await server.close();
  store.close();

  const strip = ({ pcm: _, timing: __, ...rest }: Measured) => rest;
  const summary = {
    activatedMs,
    readyMs,
    coldSubmitToFirstPcmMs: cold.submitToFirstPcmMs,
    coldRealTimeFactor: cold.realTimeFactor,
    warmSubmitToFirstPcmMs: summarize(warm.map((m) => m.submitToFirstPcmMs ?? Number.NaN)),
    warmRealTimeFactor: summarize(warm.map((m) => m.realTimeFactor ?? Number.NaN)),
    warmLastPcmToEndMs: summarize(
      warm.map((m) => m.submitToEndMs - (m.submitToLastPcmMs ?? Number.NaN)),
    ),
    refinedShare: summarize(warm.map((m) => m.refinedShare ?? Number.NaN)),
    afterCancelSubmitToFirstPcmMs: afterCancel.submitToFirstPcmMs,
    gpuMemory: { baselineMiB, peakMiB, deltaMiB: peakMiB - baselineMiB },
  };
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        spike: 'S-07',
        part: 'local',
        started,
        finished: new Date().toISOString(),
        node: process.version,
        os: { platform: platform(), release: release(), arch: arch() },
        environment: before,
        gpuAtPeak: atPeak,
        model: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice@85e237c',
        aligner: 'Qwen/Qwen3-ForcedAligner-0.6B@c7cbfc2',
        speaker: values.speaker,
        dtype: 'bfloat16',
        attention: 'sdpa',
        summary,
        cold: { ...strip(cold), timing: cold.timing },
        warm: warm.map(strip),
        canceled: strip(canceled),
        afterCancel: strip(afterCancel),
        drill,
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
