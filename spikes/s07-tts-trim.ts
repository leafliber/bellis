/**
 * 本地 TTS 修剪句首句尾静音的真机核对（qwen3 后端，接 S-07 本地部分与 P1 第 10 步的字幕偏差演练）。
 *
 *   node spikes/s07-tts-trim.ts [--speaker vivian] [--modes off,on,off,on] [--out 结果文件]
 *
 * 装配同 S-07 本地部分：插件内核在本进程里运行，只装本地 TTS 条目，直接测 `tts.local@1`，不经 OBS。
 * 每个模式拉起一次 sidecar（`off` 为 `trimSilence: false`，`on` 为缺省的修剪），就绪后热身一句不计入，
 * 再合成 S-07 的 5 句固定短句与字幕演练中首字早出的那一句。模式交替进行以抵消漂移。
 *
 * 每句记：提交到首个 PCM、到最后一帧、到流结束（对齐耗时 = 最后一帧到流结束）、音频时长；
 * 可闻部分（10ms 窗 RMS 高于 -40dBFS，与字幕演练相同）的起止与它占句长的比例；
 * 强制对齐后首字的开始时刻（相对这一句音频的开头）及它与可闻起点之差。每句的 WAV 写到结果旁的目录。
 *
 * 测量前与每个模式之前查别的 Bellis 启动器、宿主、看门狗、探针与演练（node 命令行）和别的 tts_local 进程
 * （python 命令行），以及 OBS 是否在推流或录制（经 obs-websocket 只读查询，凭据从 SecretStore 读取、不打印）；
 * 有就每 30 秒查一次，最多等 30 分钟。本进程不操作 OBS。
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
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
import { Alignment, LocalTtsService, localTts, type TtsEngine } from '@bellis/speech';
import { StateStore } from '@bellis/store';

/** S-07 本地部分的固定短句，加上字幕演练里首字早出约 0.65 秒的那一句。 */
const SENTENCES = [
  '你好，欢迎来到直播间。',
  '今天我们来玩魔女审判。',
  '这一题我选第二个选项。',
  '谢谢大家的支持，我们继续。',
  '好，那我们开始吧！',
  '接下来我们一起看看今天的安排。',
];
const AUDIBLE_DBFS = -40;
const POLL_MS = 30_000;
const WAIT_LIMIT_MS = 30 * 60_000;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const round = (v: number, digits = 1) => Math.round(v * 10 ** digits) / 10 ** digits;

function stats(values: readonly number[], digits = 1) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  // 最近秩法：第 ceil(q·n) 个。
  const rank = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
  const r = (v: number | undefined) => (v === undefined ? null : round(v, digits));
  const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : undefined;
  return {
    n: sorted.length,
    min: r(sorted[0]),
    p50: r(rank(0.5)),
    p95: r(rank(0.95)),
    max: r(sorted.at(-1)),
    mean: r(mean),
  };
}

function wav(pcm: Int16Array, sampleRate: number): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
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

/** 10ms 窗 RMS 高于 -40dBFS 的第一个与最后一个窗（毫秒）；没有时为 undefined。 */
function audible(
  pcm: Int16Array,
  sampleRate: number,
): { onsetMs: number; offsetMs: number } | undefined {
  const window = Math.round(sampleRate / 100);
  const limit = (32768 * 10 ** (AUDIBLE_DBFS / 20)) ** 2;
  const loud: number[] = [];
  for (let i = 0; i < pcm.length; i += window) {
    const end = Math.min(pcm.length, i + window);
    let sum = 0;
    for (let j = i; j < end; j++) sum += (pcm[j] as number) ** 2;
    if (sum > limit * (end - i)) loud.push(i);
  }
  const first = loud[0];
  const last = loud.at(-1);
  if (first === undefined || last === undefined) return undefined;
  return {
    onsetMs: (first * 1000) / sampleRate,
    offsetMs: (Math.min(pcm.length, last + window) * 1000) / sampleRate,
  };
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
}

function processTable(): Proc[] {
  const out = powershell(
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress',
  );
  return (
    JSON.parse(out) as Array<{
      ProcessId: number;
      ParentProcessId: number;
      Name: string;
      CommandLine: string | null;
    }>
  ).map((p) => ({
    pid: p.ProcessId,
    ppid: p.ParentProcessId,
    name: p.Name,
    commandLine: p.CommandLine ?? '',
  }));
}

const BLOCKING_NODE =
  /packages[\\/](launcher|host|watchdog)[\\/]src[\\/]main\.ts|spikes[\\/](drill-[\w-]+|s\d\d-[\w-]+|s01-stage[\\/]server)\.ts/i;
const TTS_LOCAL = /-m\s+tts_local\b/;

function obsOk(result: ObsResult): Record<string, unknown> {
  if (!result.ok)
    throw new Error(`${result.requestType} 失败：${result.code} ${result.comment ?? ''}`);
  return result.data ?? {};
}

/** 别的 Bellis 进程与 tts_local（不含本进程与它的后代），以及 OBS 的推流、录制状态。 */
async function checkLoad() {
  const table = processTable();
  const own = new Set([process.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of table)
      if (!own.has(p.pid) && p.ppid !== 0 && own.has(p.ppid)) {
        own.add(p.pid);
        grew = true;
      }
  }
  const blocking = table
    .filter((p) => !own.has(p.pid))
    .filter(
      (p) =>
        (/^node\.exe$/i.test(p.name) && BLOCKING_NODE.test(p.commandLine)) ||
        (/^python(w)?\.exe$/i.test(p.name) && TTS_LOCAL.test(p.commandLine)),
    )
    .map((p) => `${p.pid} ${p.name}: ${p.commandLine}`);
  const running = table.some((p) => /^obs64\.exe$/i.test(p.name));
  let obs: { running: boolean; streaming?: boolean; recording?: boolean } = { running };
  if (running) {
    const secret = await readObsSecret(
      new KeyringSecretStore(process.env.BELLIS_SECRET_SERVICE ?? 'bellis'),
      OBS_SECRET,
    );
    const client = await ObsClient.connect(secret.url, secret.password);
    try {
      obs = {
        running,
        streaming: obsOk(await client.request('GetStreamStatus')).outputActive === true,
        recording: obsOk(await client.request('GetRecordStatus')).outputActive === true,
      };
    } finally {
      client.close();
    }
  }
  return { at: new Date().toISOString(), blocking, obs };
}

async function waitForQuiet() {
  const started = Date.now();
  for (;;) {
    const load = await checkLoad();
    const reasons = [
      ...load.blocking,
      ...(load.obs.streaming ? ['OBS 在推流'] : []),
      ...(load.obs.recording ? ['OBS 在录制'] : []),
    ];
    if (reasons.length === 0) return { ...load, waitedMs: Date.now() - started };
    if (Date.now() - started + POLL_MS > WAIT_LIMIT_MS)
      throw new Error(`等了 30 分钟仍有别的负载：\n${reasons.join('\n')}`);
    console.log(`有别的负载，${POLL_MS / 1000} 秒后再查：\n${reasons.join('\n')}`);
    await sleep(POLL_MS);
  }
}

/** 每块之前 2 秒的整机 CPU 占用（%）。 */
async function backgroundCpu(): Promise<number> {
  const busy = () => cpus().map((c) => c.times.user + c.times.nice + c.times.sys + c.times.irq);
  const a = busy();
  const t = performance.now();
  await sleep(2000);
  const b = busy();
  const elapsed = performance.now() - t;
  return round((b.reduce((s, v, i) => s + v - (a[i] ?? v), 0) / (elapsed * b.length)) * 100);
}

function entry(id: string, plugin: string, config: unknown = {}): ResolvedEntry {
  return { id, plugin, config, disabled: false, explicitSwitch: false, grant: [] };
}

interface Sample {
  text: string;
  firstPcmMs: number | null;
  lastPcmMs: number | null;
  endMs: number;
  alignMs: number | null;
  audioMs: number;
  realTimeFactor: number | null;
  onsetMs: number | null;
  offsetMs: number | null;
  /** 可闻部分占句长的比例。 */
  audibleShare: number | null;
  /** 句尾在可闻部分之后的时长。 */
  tailMs: number | null;
  /** 已由强制对齐细化的码点数；为 0 时首字时刻只是插值。 */
  refinedChars: number;
  firstCharMs: number | null;
  firstCharMinusOnsetMs: number | null;
  wav: string;
}

/** 拉起一次本地 TTS（一个 sidecar），合成热身句与全部短句后停用。 */
async function session(trim: boolean, speaker: string, tag: string, wavDir: string) {
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
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const host = new Kernel({
    clock,
    safety: safety.kernelHooks(),
    log: (event, fields) => logs.push({ event, fields }),
  });
  kernel = host;
  host.provideScoped(SafetyService, ({ instanceId }) => safetyFacade(safety, instanceId));
  const credentials = {
    path: createChannelPath(`trim${randomBytes(3).toString('hex')}`),
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
  try {
    const t0 = performance.now();
    host.add(
      [
        entry('tts-local', 'tts-local', {
          backend: 'qwen3',
          qwen3: { speaker, language: 'chinese', trimSilence: trim },
          synthesizeTimeoutMs: 300_000,
        }),
      ],
      catalog(localTts),
    );
    await host.settled();
    const deadline = performance.now() + 300_000;
    while (!engine()?.ready) {
      if (store.events().some((e) => e.type === 'tts.degraded') || performance.now() > deadline)
        throw new Error(`模型未就绪：${engine()?.status ?? '本地引擎不在'}`);
      await sleep(50);
    }
    const local = engine() as TtsEngine;
    const readyMs = Math.round(performance.now() - t0);

    const measure = async (text: string, name: string): Promise<Sample> => {
      const started = performance.now();
      const synthesis = await local.synthesize(text, new AbortController().signal);
      let first: number | undefined;
      let last: number | undefined;
      const chunks: Int16Array[] = [];
      for await (const frame of synthesis.frames) {
        const now = performance.now();
        first ??= now;
        last = now;
        chunks.push(frame);
      }
      const end = performance.now();
      const pcm = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
      let offset = 0;
      for (const c of chunks) {
        pcm.set(c, offset);
        offset += c.length;
      }
      const rate = synthesis.sampleRate;
      const audioMs = (pcm.length * 1000) / rate;
      const span = audible(pcm, rate);
      // 流结束后的映射：首字的开始采样（强制对齐细化过时即对齐结果）。
      const timing = synthesis.timing ?? [];
      const firstChar = timing[0];
      // 与纯插值相差超过 10ms 的码点数（同 S-07）：为 0 时这一句没有对齐结果。
      const plain = new Alignment(text, rate, { msPerChar: 220 });
      plain.complete(synthesis.totalSamples ?? pcm.length);
      const refinedChars = timing.filter(
        (t, i) => Math.abs(t.sample - (plain.timing[i]?.sample ?? t.sample)) > rate / 100,
      ).length;
      const firstCharMs = firstChar ? (firstChar.sample * 1000) / rate : null;
      const file = join(wavDir, `${name}.wav`);
      writeFileSync(file, wav(pcm, rate));
      return {
        text,
        firstPcmMs: first === undefined ? null : round(first - started),
        lastPcmMs: last === undefined ? null : round(last - started),
        endMs: round(end - started),
        alignMs: last === undefined ? null : round(end - last),
        audioMs: round(audioMs),
        realTimeFactor:
          last === undefined || audioMs === 0 ? null : round((last - started) / audioMs, 3),
        onsetMs: span ? round(span.onsetMs) : null,
        offsetMs: span ? round(span.offsetMs) : null,
        audibleShare: span ? round((span.offsetMs - span.onsetMs) / audioMs, 3) : null,
        tailMs: span ? round(audioMs - span.offsetMs) : null,
        refinedChars,
        firstCharMs: firstCharMs === null ? null : round(firstCharMs),
        firstCharMinusOnsetMs:
          firstCharMs === null || !span ? null : round(firstCharMs - span.onsetMs),
        wav: file,
      };
    };

    const warmup = await measure(SENTENCES[0] as string, `${tag}-warmup`);
    const samples: Sample[] = [];
    for (const [i, text] of SENTENCES.entries()) {
      const m = await measure(text, `${tag}-${i + 1}`);
      samples.push(m);
      console.log(
        `  ${text} 首个 PCM ${m.firstPcmMs}ms，句长 ${m.audioMs}ms，可闻 ${m.onsetMs}–${m.offsetMs}ms（${m.audibleShare}），首字 ${m.firstCharMs}ms（相对可闻起点 ${m.firstCharMinusOnsetMs}ms，细化 ${m.refinedChars} 字），对齐 ${m.alignMs}ms`,
      );
    }
    return {
      readyMs,
      warmup,
      samples,
      logs: logs.filter((l) => l.event.startsWith('tts') || l.event.startsWith('sidecar')),
    };
  } finally {
    await host.shutdown();
    await server.close();
    store.close();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      speaker: { type: 'string', default: 'vivian' },
      modes: { type: 'string', default: 'off,on,off,on' },
      out: { type: 'string' },
    },
  });
  if (process.platform !== 'win32') throw new Error('只在 Windows 上运行');
  const started = new Date().toISOString();
  const out = resolve(values.out ?? join('reports', `tts-trim-${started.slice(0, 10)}.json`));
  const wavDir = out.replace(/\.json$/, '');
  mkdirSync(wavDir, { recursive: true });
  mkdirSync(dirname(out), { recursive: true });
  const modes = values.modes.split(',').map((m) => {
    if (m !== 'on' && m !== 'off') throw new Error(`未知模式 ${m}`);
    return m;
  });

  const runs: Array<Record<string, unknown> & { mode: string; samples: Sample[] }> = [];
  for (const [i, mode] of modes.entries()) {
    const load = await waitForQuiet();
    const cpu = await backgroundCpu();
    console.log(`第 ${i + 1} 次（修剪 ${mode}）：负载 ${JSON.stringify(load)}，背景 CPU ${cpu}%`);
    const result = await session(mode === 'on', values.speaker, `${i + 1}-${mode}`, wavDir);
    runs.push({ run: i + 1, mode, load, backgroundCpuPercent: cpu, ...result });
  }

  const summarize = (samples: readonly Sample[]) => {
    const pick = (f: (s: Sample) => number | null, digits = 1) =>
      stats(
        samples.map((s) => f(s) ?? Number.NaN),
        digits,
      );
    return {
      firstPcmMs: pick((s) => s.firstPcmMs),
      endMs: pick((s) => s.endMs),
      alignMs: pick((s) => s.alignMs),
      audioMs: pick((s) => s.audioMs),
      realTimeFactor: pick((s) => s.realTimeFactor, 3),
      onsetMs: pick((s) => s.onsetMs),
      tailMs: pick((s) => s.tailMs),
      audibleShare: pick((s) => s.audibleShare, 3),
      firstCharMs: pick((s) => s.firstCharMs),
      firstCharMinusOnsetMs: pick((s) => s.firstCharMinusOnsetMs),
      unrefined: samples.filter((s) => s.refinedChars === 0).length,
    };
  };
  const of = (mode: string) => runs.filter((r) => r.mode === mode).flatMap((r) => r.samples);
  const last = SENTENCES.at(-1) as string;
  const summary = {
    off: summarize(of('off')),
    on: summarize(of('on')),
    /** 字幕演练中首字早出的那一句。 */
    lastSentence: {
      off: of('off')
        .filter((s) => s.text === last)
        .map((s) => ({ onsetMs: s.onsetMs, firstCharMs: s.firstCharMs })),
      on: of('on')
        .filter((s) => s.text === last)
        .map((s) => ({ onsetMs: s.onsetMs, firstCharMs: s.firstCharMs })),
    },
  };
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        part: 'tts-trim',
        started,
        finished: new Date().toISOString(),
        node: process.version,
        os: { platform: platform(), release: release() },
        cpu: cpus()[0]?.model,
        model: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice@85e237c',
        aligner: 'Qwen/Qwen3-ForcedAligner-0.6B@c7cbfc2',
        speaker: values.speaker,
        trim: { thresholdDbfs: -55, marginMs: 30, windowMs: 10 },
        audibleDbfs: AUDIBLE_DBFS,
        sentences: SENTENCES,
        modes,
        summary,
        runs,
      },
      null,
      2,
    )}\n`,
  );
  console.log(JSON.stringify(summary, null, 2));
  console.log(`结果已写入 ${out}`);
}

await main();
