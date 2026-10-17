/**
 * P1 第 10 步的真机长测工具：真实 Stage 长时间连续播报（P1 任务卡出口“OBS 最小化或被游戏遮挡 30 分钟，
 * 播放无欠载与音高漂移（OBS 录制比对）”）。OBS 最小化或被游戏遮挡由运行的人事先安排，本工具只采样核对。
 *
 *   node spikes/drill-stage-long.ts --stage-source 名字 [--safe-scene Safe] [--minutes N] [--record]
 *                                    [--out 结果文件前缀]
 *
 * 用启动器拉起真实宿主与看门狗。profile 含 OBS 控制、真实 Stage、440Hz 测试音的模拟 TTS（24kHz）、发声仲裁、
 * 首尾相接排期的定时播报（每句约 6 秒）与审核显式关闭；确认在场后切到 M2，运行期间每 2 分钟重新确认在场。
 * 记录：
 *   - 页面侧（宿主日志）：每句的回报摘要 stage.sentence（实际播出采样、欠载次数、游标回报次数与最大间隔，
 *     游标推进速率相对标称采样率的偏差）、欠载 stage.underrun、静音 stage.muted、截断（丢弃）及其原因。
 *   - 每 30 秒采样一次 OBS 主窗口：是否最小化、是否在前台、前台进程。
 *   - 每秒各输入的音量表峰值（同 S-01）：Stage 源之外的输入有声时，录音里会混进别的声音。
 *   - --record：全程让 OBS 录制，结束后用 S-01 的分析器按句段分析录音：句内断流（时长与一句不符的句段）、
 *     相位跳变、音高偏差、异常峰值。录制文件保留在 OBS 的录制目录。
 * 到时后等当前一句播完再急停，停止录制并等文件写完，恢复浏览器源设置（含 URL）、场景与静音，整体读回比对。
 * 推流或录制进行中、或有别的 Bellis 进程在运行时拒绝运行。
 * 用临时的 SecretStore 服务名存放会话信息与 OBS 凭据副本，结束时删除。结果写 <前缀>.json，宿主日志写 <前缀>.jsonl。
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
import { differences, type ObsSnapshot, restoreSnapshot, snapshot } from './obs-snapshot.ts';
import { analyzeSegments } from './s01-stage/analyze-recording.ts';
import { type MeterReading, ObsMeters } from './s01-stage/meters.ts';
import { obsWindowState, type WindowState } from './s01-stage/window.ts';

const file = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const hostMain = file('../packages/host/src/main.ts');
const watchdogMain = file('../packages/watchdog/src/main.ts');
const liveExample = file('../config/live.example.json');
const SAMPLE_RATE = 24_000;
const SAMPLES_PER_CHAR = 3600;
const TONE_HZ = 440;
/** 40 个字加句号；模拟 TTS 每个码点 0.15 秒，每句 6.15 秒。 */
const TEXT = '这是一句用来长时间核对真实舞台连续播放的测试播报内容请不要在意它说的具体意思谢谢。';
const PRESENCE_EVERY_MS = 120_000;
const WINDOW_EVERY_MS = 30_000;
/** 首句排在插件激活后这么久，留出页面认证与切到 M2 的时间。 */
const FIRST_AT_MS = 8000;

type LogLine = { t: string; event: string; [field: string]: unknown };

class Lines {
  readonly items: LogLine[] = [];
  readonly raw: string[] = [];
  readonly #waiters = new Set<() => void>();

  constructor(stream: Readable | null) {
    if (!stream) throw new Error('没有可读的输出');
    createInterface({ input: stream }).on('line', (line) => {
      this.raw.push(line);
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

function summarize(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const r = (v: number) => Math.round(v * 10) / 10;
  return {
    n: sorted.length,
    min: r(sorted[0] ?? 0),
    p50: r(at(0.5)),
    p95: r(at(0.95)),
    p99: r(at(0.99)),
    max: r(sorted.at(-1) ?? 0),
  };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

interface SentenceLog extends LogLine {
  sentenceId: string;
  played: number;
  complete: boolean;
  reason?: string;
  startedAt: number | null;
  endedAt: number;
  underruns: number;
  cursors: number;
  firstCursor: [number, number] | null;
  lastCursor: [number, number] | null;
  maxCursorGapMs: number;
}

/** 运行期间的日志：从切到 M2 的那条事实起。 */
function runLines(lines: LogLine[]): LogLine[] {
  const from = lines.findIndex(
    (l) =>
      l.event === 'fact' &&
      l.type === 'supervision.changed' &&
      (l.data as { to?: string }).to === 'M2',
  );
  return from < 0 ? lines : lines.slice(from);
}

/**
 * 页面侧的统计：来自宿主日志里 Stage 服务记下的页面回报。
 * 游标只统计回报次数与间隔：宿主收到回报的时刻有十几毫秒的抖动（Windows 定时粒度 15.6ms），
 * 按单句（约 6 秒）折算速率误差达数千 ppm，没有意义；长期偏差看录音与宿主时刻的对齐（recording.alignment）。
 */
function pageSide(lines: LogLine[]) {
  const sentences = lines.filter((l) => l.event === 'stage.sentence') as SentenceLog[];
  const complete = sentences.filter((s) => s.complete);
  // 宿主看到的句间空白：上一句 ended 到下一句 started。
  const gapsMs: number[] = [];
  for (let i = 1; i < sentences.length; i++) {
    const prev = sentences[i - 1];
    const next = sentences[i];
    if (prev && next?.startedAt != null) gapsMs.push(next.startedAt - prev.endedAt);
  }
  return {
    sentences: sentences.length,
    complete: complete.length,
    truncated: sentences
      .filter((s) => !s.complete)
      .map((s) => ({ t: s.t, sentenceId: s.sentenceId, played: s.played, reason: s.reason })),
    underruns: sentences.reduce((n, s) => n + s.underruns, 0),
    underrunEvents: lines
      .filter((l) => l.event === 'stage.underrun')
      .map((l) => ({ t: l.t, sentenceId: l.sentenceId, played: l.played })),
    muted: lines
      .filter((l) => l.event === 'stage.muted')
      .map((l) => ({ t: l.t, reason: l.reason })),
    cursor: {
      reportsPerSentence: summarize(complete.map((s) => s.cursors)),
      maxGapMs: summarize(complete.map((s) => s.maxCursorGapMs)),
      /** 末次游标与句子总采样数之差（采样）：游标一直推进到句尾附近。 */
      lastShortOfTotal: summarize(complete.map((s) => s.played - (s.lastCursor?.[1] ?? 0))),
    },
    hostGapMs: summarize(gapsMs),
  };
}

/** 运行期间的其余事实：发言结果、监督模式变化、Stage 页面的断开与拒绝。 */
function runFacts(run: LogLine[]) {
  const utterances: Record<string, number> = {};
  for (const l of run.filter((l) => l.event === 'fact' && l.type === 'utterance.played')) {
    const end = (l.data as { end: string }).end;
    utterances[end] = (utterances[end] ?? 0) + 1;
  }
  return {
    utterances,
    supervision: run
      .filter((l) => l.event === 'fact' && String(l.type).startsWith('supervision.'))
      .map((l) => ({ t: l.t, type: l.type, data: l.data })),
    stagePage: run
      .filter((l) => String(l.event).startsWith('stage-page.'))
      .map((l) => ({ t: l.t, event: l.event, reason: l.reason ?? null })),
  };
}

/**
 * 录音的按句段分析，再把句段与宿主记下的句子按时间对齐：以首句为初值就近匹配，对其余各对做线性回归。
 * 斜率偏离 1 即 OBS 输出的时间线相对宿主时钟漂移（例如 OBS 的音频缓冲越积越多）。
 * 首句不参与回归：静默之后的第一句在录音里开头可能缺几十毫秒，起点不准。
 */
async function recordingOf(path: string, run: LogLine[]) {
  const sentences = run.filter((l) => l.event === 'stage.sentence') as SentenceLog[];
  const complete = sentences.filter((s) => s.complete && s.startedAt !== null);
  const expectedSeconds = (complete[0]?.played ?? 0) / SAMPLE_RATE || undefined;
  const analysis = await analyzeSegments(path, {
    toneHz: TONE_HZ,
    ...(expectedSeconds === undefined ? {} : { expectedSeconds }),
    trailingEdge: true,
  });
  const segments = analysis.segments.listed;
  const first = segments[0];
  const pairs: Array<[x: number, y: number]> = [];
  let unmatched = 0;
  if (first && complete[0]) {
    const offset = first.atSeconds - (complete[0].startedAt as number) / 1000;
    for (const s of complete.slice(1)) {
      const x = (s.startedAt as number) / 1000;
      let best: number | undefined;
      for (const segment of segments.slice(1)) {
        const d = Math.abs(segment.atSeconds - (x + offset));
        if (d < 0.5 && (best === undefined || d < Math.abs(best - (x + offset))))
          best = segment.atSeconds;
      }
      if (best === undefined) unmatched += 1;
      else pairs.push([x, best]);
    }
  }
  let alignment: Record<string, unknown> | null = null;
  if (pairs.length >= 2) {
    const n = pairs.length;
    const mx = pairs.reduce((a, [x]) => a + x, 0) / n;
    const my = pairs.reduce((a, [, y]) => a + y, 0) / n;
    const sxx = pairs.reduce((a, [x]) => a + (x - mx) ** 2, 0);
    const sxy = pairs.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0);
    const slope = sxy / sxx;
    const residuals = pairs.map(([x, y]) => Math.abs(y - (my + slope * (x - mx))) * 1000);
    alignment = {
      pairs: n,
      spanSeconds: Math.round(((pairs.at(-1)?.[0] ?? 0) - (pairs[0]?.[0] ?? 0)) * 10) / 10,
      slopePpm: Math.round((slope - 1) * 1e6 * 10) / 10,
      residualMs: summarize(residuals),
    };
  }
  const expectedMs = (expectedSeconds ?? 0) * 1000;
  return {
    path,
    bytes: statSync(path).size,
    completeSentencesLogged: complete.length,
    innerSegments: segments.filter((s) => !s.edge).length,
    /** 静默之后的第一句：开头缺多少毫秒。 */
    firstSegment: first
      ? { ...first, shortOfSentenceMs: Math.round((expectedMs - first.seconds * 1000) * 10) / 10 }
      : null,
    mismatchedExceptFirst: analysis.mismatched.listed.filter((s) => s !== first).length,
    unmatchedSentences: unmatched,
    alignment,
    ...analysis,
  };
}

/** 用保存的宿主日志与录制文件重做分析（不碰 OBS），结果写回同一个报告。 */
async function reanalyze(prefix: string): Promise<void> {
  const report = JSON.parse(readFileSync(`${prefix}.json`, 'utf8')) as Record<string, unknown>;
  const lines = readFileSync(`${prefix}.jsonl`, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as LogLine];
      } catch {
        return [];
      }
    });
  const run = runLines(lines);
  report.page = pageSide(run);
  Object.assign(report, runFacts(run));
  const path = (report.recording as { path?: string } | undefined)?.path;
  if (path) report.recording = await recordingOf(path, run);
  report.reanalyzedAt = new Date().toISOString();
  writeFileSync(`${prefix}.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`已重做分析：${prefix}.json`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'stage-source': { type: 'string' },
      'safe-scene': { type: 'string', default: 'Safe' },
      minutes: { type: 'string', default: '1' },
      record: { type: 'boolean', default: false },
      out: { type: 'string' },
      reanalyze: { type: 'string' },
    },
  });
  if (values.reanalyze) {
    await reanalyze(resolve(values.reanalyze));
    return;
  }
  const stageSource = values['stage-source'];
  if (!stageSource) throw new Error('需要 --stage-source');
  const safeScene = values['safe-scene'];
  const minutes = Number(values.minutes);
  if (!(minutes > 0)) throw new Error('--minutes 须为正数');
  const started = new Date().toISOString();
  const out = resolve(
    values.out ?? join('reports', `drill-stage-long-${started.replace(/[:.]/g, '-')}`),
  );
  const say = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

  await waitForNoOtherBellis({ log: say });
  const secret = await readObsSecret(new KeyringSecretStore('bellis'), OBS_SECRET);
  const obs = await ObsClient.connect(secret.url, secret.password);
  /** 每个输入每一秒的峰值（dBFS），秒数从切到 M2 算起；之前的读数不记。 */
  const levels = new Map<string, number[]>();
  let levelsFrom: number | undefined;
  const meters = await ObsMeters.connect(
    secret.url,
    secret.password,
    (readings: MeterReading[]) => {
      if (levelsFrom === undefined) return;
      const second = Math.floor((Date.now() - levelsFrom) / 1000);
      for (const reading of readings) {
        const series = levels.get(reading.name) ?? [];
        series[second] = Math.max(series[second] ?? -Infinity, reading.peakDb);
        levels.set(reading.name, series);
      }
    },
  );
  const service = `bellis-drill-${randomBytes(4).toString('hex')}`;
  const store = new KeyringSecretStore(service);
  const configPath = join(tmpdir(), `${service}.json`);
  const profilePath = join(tmpdir(), `${service}.profile.json`);
  const storePath = join(tmpdir(), `${service}.db`);
  // 模拟 TTS 按朗读文本的码点数计时长；这句没有不发音的符号，句号也算一个码点。
  const chars = [...TEXT].length;
  const sentenceMs = (chars * SAMPLES_PER_CHAR * 1000) / SAMPLE_RATE;
  let original: ObsSnapshot | undefined;
  let session: Session | undefined;
  let host: Lines | undefined;
  let recording = false;
  let recordingPath: string | undefined;
  const timers: NodeJS.Timeout[] = [];
  const windows: WindowState[] = [];
  const result: Record<string, unknown> = {
    text: { chars, sentenceMs, intervalMs: sentenceMs },
  };
  try {
    if (ok(await obs.request('GetStreamStatus')).outputActive)
      throw new Error('推流进行中，拒绝运行');
    if (ok(await obs.request('GetRecordStatus')).outputActive)
      throw new Error('录制进行中，拒绝运行');
    result.obsVersion = ok(await obs.request('GetVersion')).obsVersion;
    original = await snapshot(obs, stageSource, safeScene);
    if (original.programScene === safeScene) throw new Error('节目场景已经是安全场景');
    ok(await obs.request('SetInputMute', { inputName: stageSource, inputMuted: false }));
    await writeObsSecret(store, secret, OBS_SECRET);

    // 首尾相接排期：间隔等于一句的时长。仲裁一次只播一句，句间开销让队列慢慢积压，所以留足过期时间。
    const count = Math.ceil((minutes * 60_000 + 30_000) / sentenceMs) + 2;
    const announcements = Array.from({ length: count }, (_, i) => ({
      id: `long${i}`,
      atMs: FIRST_AT_MS + Math.round(i * sentenceMs),
      text: TEXT,
    }));
    writeFileSync(
      profilePath,
      JSON.stringify({
        name: 'drill-stage-long',
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
                  sampleRate: SAMPLE_RATE,
                  samplesPerChar: SAMPLES_PER_CHAR,
                  frameSamples: 480,
                  toneHz: TONE_HZ,
                },
              },
              { id: 'speech', plugin: 'speech-arbiter', grant: ['speech.output'] },
              {
                id: 'schedule',
                plugin: 'speech-schedule',
                config: { announcements, ttlMs: 120_000 },
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
    const lines = new Lines(session.host.stdout);
    host = lines;
    void new Lines(session.watchdog.stdout);
    const key = decodeSessionKey(session.info.channelKey);
    const operator = new RpcPeer(await connect(session.info.channelPath, Role.Operator, { key }), {
      timeoutMs: 10_000,
    });
    const call = (method: string, params: Record<string, unknown> = {}) =>
      operator.request(method, params) as Promise<Record<string, unknown>>;

    await lines.wait((l) => l.event === 'stage-page.authenticated', 30_000);
    const connected = await lines
      .wait((l) => l.event === 'fact' && l.type === 'stage.connected', 5000)
      .catch(() => undefined);
    result.handshake = connected?.data ?? null;
    // M2 的预检含在场确认（安全核的前置条件），先确认在场再等预检通过。
    await call(OperatorMethod.Presence);
    for (const deadline = Date.now() + 20_000; ; ) {
      const failures = (await call(OperatorMethod.Preflight, { target: 'M2' }))
        .failures as string[];
      if (failures.length === 0) break;
      if (Date.now() > deadline) throw new Error(`预检未通过：${failures.join('；')}`);
      await sleep(250);
    }

    if (values.record) {
      ok(await obs.request('StartRecord'));
      recording = true;
      say('录制开始');
    }
    const sample = async () => {
      const state = await obsWindowState();
      windows.push(state);
      say(`OBS 窗口：${JSON.stringify(state)}`);
    };
    await sample();
    await call(OperatorMethod.Presence);
    const m2 = await call(OperatorMethod.Mode, { target: 'M2' });
    if (m2.ok !== true) throw new Error(`进入 M2 失败：${JSON.stringify(m2)}`);
    const m2At = Date.now();
    levelsFrom = m2At;
    say(`已切到 M2，运行 ${minutes} 分钟`);
    const presenceErrors: string[] = [];
    timers.push(
      setInterval(() => {
        call(OperatorMethod.Presence).catch((error: Error) => presenceErrors.push(error.message));
      }, PRESENCE_EVERY_MS),
      setInterval(() => void sample(), WINDOW_EVERY_MS),
      setInterval(() => {
        const page = pageSide(runLines(lines.items));
        say(
          `进度：${page.sentences} 句（完整 ${page.complete}），欠载 ${page.underruns}，截断 ${page.truncated.length}`,
        );
      }, 60_000),
    );
    await sleep(minutes * 60_000);
    for (const timer of timers) clearInterval(timer);
    await sample();
    // 等当前一句播完再急停，尽量不截断。
    const endFrom = lines.items.length;
    await lines
      .wait((l) => l.event === 'stage.sentence', sentenceMs + 10_000, endFrom)
      .catch(() => undefined);
    await call(OperatorMethod.EmergencyStop, { reason: '长测结束' });
    const endedAt = Date.now();
    levelsFrom = undefined;
    say('已急停');
    if (recording) {
      recordingPath = ok(await obs.request('StopRecord')).outputPath as string;
      recording = false;
      // StopRecord 返回时 OBS 可能还在写文件末尾：等录制确实停下、文件大小稳定。
      for (let size = -1; ; ) {
        await sleep(1000);
        const active = ok(await obs.request('GetRecordStatus')).outputActive;
        const now = statSync(recordingPath).size;
        if (!active && now === size) break;
        size = now;
      }
      say(`录制已停止：${recordingPath}`);
    }
    await sleep(500);
    const run = runLines(lines.items);
    result.run = {
      m2At: new Date(m2At).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      seconds: Math.round((endedAt - m2At) / 100) / 10,
      presenceErrors,
    };
    result.page = pageSide(run);
    Object.assign(result, runFacts(run));
    result.window = {
      samples: windows,
      count: windows.length,
      minimized: windows.filter((w) => w.minimized === true).length,
      foreground: windows.filter((w) => w.foreground === true).length,
    };
    result.levels = Object.fromEntries(
      [...levels].map(([name, series]) => {
        const observed = series.filter((db) => db !== undefined);
        return [
          name,
          {
            seconds: observed.length,
            audibleSeconds: observed.filter((db) => db > -40).length,
            maxDb: Math.max(...observed),
            perSecondDb: series.map((db) =>
              Number.isFinite(db) ? Math.round(db * 10) / 10 : null,
            ),
          },
        ];
      }),
    );
    if (recordingPath) {
      say('分析录音……');
      result.recording = await recordingOf(recordingPath, run);
    }
    operator.connection.close();
  } catch (error) {
    result.error = (error as Error).stack ?? String(error);
    say(`长测中止：${(error as Error).message}`);
  } finally {
    for (const timer of timers) clearInterval(timer);
    if (recording) {
      const stopped = await obs.request('StopRecord').catch(() => undefined);
      recordingPath ??= stopped?.data?.outputPath as string | undefined;
      result.recordingStoppedAfterError = recordingPath ?? true;
    }
    await session?.stop();
    meters.close();
    if (original) {
      const steps = await restoreSnapshot(obs, original, stageSource);
      const diffs = differences(original, await snapshot(obs, stageSource, safeScene));
      result.obsRestored = { ok: steps.length === 0 && diffs.length === 0, steps, diffs };
      say(`OBS 恢复：${JSON.stringify(result.obsRestored)}`);
    }
    obs.close();
    await store.delete(OBS_SECRET);
    await store.delete(SESSION_SECRET);
    for (const path of [configPath, profilePath]) rmSync(path, { force: true });
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${storePath}${suffix}`, { force: true });
  }
  mkdirSync(dirname(out), { recursive: true });
  if (host) writeFileSync(`${out}.jsonl`, `${host.raw.join('\n')}\n`);
  writeFileSync(
    `${out}.json`,
    `${JSON.stringify({ drill: 'stage-long', started, finished: new Date().toISOString(), node: process.version, stageSource, safeScene, minutes, record: values.record, ...result }, null, 2)}\n`,
  );
  console.log(`结果已写入 ${out}.json`);
}

await main();
