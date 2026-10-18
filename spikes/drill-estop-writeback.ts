/**
 * 急停时的写回实测（发声文档“播放游标与写回”）：测试音一句播到中途时操作员急停。安全核吊销许可，页面截断并回报
 * 已播出的采样数 played；同时经 OBS 应急连接静音 Stage 源、切安全场景。从录像音轨量出这一句实际播出到第几个采样，
 * 与 played、played − D（急停前的呈现延迟）对比。
 *
 *   node spikes/drill-estop-writeback.ts --stage-source 名字 [--safe-scene Safe] [--trials 12] [--out 结果文件前缀]
 *   node spikes/drill-estop-writeback.ts --reanalyze 结果文件前缀
 *
 * 录像的音轨要是观众听到的那条混音：运行前读出 OBS 的输出设置，简单输出模式且录像质量“与推流相同”时，录制与推流
 * 共用同一个音频编码器（同一条混音轨），记进结果；不是时照常运行，但结果里注明。
 *
 * 用启动器拉起真实宿主与看门狗。profile 含 OBS 控制、真实 Stage、stage-sync、440Hz 测试音的模拟 TTS（24kHz，
 * 每个码点 0.15 秒）、发声仲裁、每 8 秒一句的定时播报（每句 6.15 秒）与审核显式关闭。全程一段录制：
 * 每轮切回直播场景、取消静音、确认在场、切到 M2，等下一句在 Stage 源的音量表上出声后过一段时间急停，
 * 急停时刻在各轮之间从句首附近排到句尾附近。
 *
 * 录音按句段切分（同 S-01，测试音约 -14dBFS，无声门限 0.05）：被急停的那一句的句段时长即实际播出的时长，
 * 换算成原始采样数 heard。多算 = played − heard；扣掉 D 之后的差 = played − D×采样率/1000 − heard。
 *
 * 会改写浏览器源的 URL、切换节目场景、静音并开关录制；推流或录制进行中、或有别的 Bellis 进程在运行时拒绝运行。
 * 结束时恢复浏览器源设置（含 URL）、场景与静音，整体读回比对。录制文件保留在 OBS 的录制目录。
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

const file = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const hostMain = file('../packages/host/src/main.ts');
const watchdogMain = file('../packages/watchdog/src/main.ts');
const liveExample = file('../config/live.example.json');
const SAMPLE_RATE = 24_000;
const SAMPLES_PER_CHAR = 3600;
const TONE_HZ = 440;
/** 40 个字加句号：每句 6.15 秒。 */
const TEXT = '这是一句用来核对急停时已播出部分的测试播报内容请不要在意它说的具体意思谢谢。';
const ANNOUNCE_EVERY_MS = 8000;
const FIRST_AT_MS = 8000;
/** 音量表峰值高于它算出声（测试音约 -14dBFS，唤醒信号 -50dBFS）。 */
const SOUND_DB = -30;
/** 急停时刻（从音量表出声算起）的范围；音量表比页面开始播晚约 0.1 秒。 */
const EARLIEST_MS = 200;
const LATEST_MS = 5600;

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

/** Stage 源最近一次音量表读数。 */
class Meter {
  latest: { db: number; at: number } | undefined;
  readonly name: string;
  readonly #waiters = new Set<() => void>();

  constructor(name: string) {
    this.name = name;
  }

  update(readings: MeterReading[]): void {
    const reading = readings.find((r) => r.name === this.name);
    if (!reading) return;
    this.latest = { db: reading.peakDb, at: Date.now() };
    for (const wake of this.#waiters) wake();
  }

  /** 等到 after 之后的一次读数满足条件，返回它到达的时刻。 */
  async until(match: (db: number) => boolean, timeoutMs: number, after: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const latest = this.latest;
      if (latest && latest.at > after && match(latest.db)) return latest.at;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`音量表未在时限内满足条件：${latest?.db}`);
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
    max: r(sorted.at(-1) ?? 0),
  };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const say = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

/** 一轮急停在宿主与驱动这边记下的事。 */
interface Trial {
  index: number;
  /** 计划的急停时刻（从音量表出声算起，毫秒）。 */
  plannedMs: number;
  /** 急停前从操作员状态读到的呈现延迟。 */
  presentation: { delayMs: number; samples: number; source: string } | null;
  soundAt: string;
  estopAt: string;
  /** 操作员急停的应答：OBS 应急动作是否成功。 */
  obsOk: boolean | null;
  sentenceId: string | null;
  /** 页面回报的已播出采样数与截断原因（宿主日志 stage.sentence）。 */
  played: number | null;
  reason: string | null;
  /** 页面开始播这一句的墙钟时刻（由 stage.sentence 的宿主时钟换算）。 */
  startedWall: number | null;
  /** 宿主记下急停请求与应急动作完成之间的时长。 */
  emergencyMs: number | null;
}

interface Measured extends Trial {
  segment: { atSeconds: number; seconds: number } | null;
  heard: number | null;
  /** 多算的采样数与毫秒：played − heard。 */
  overSamples: number | null;
  overMs: number | null;
  /** 扣掉 D 后剩下的毫秒：played − D − heard（正为仍多算，负为扣多了）。 */
  afterDMs: number | null;
  /** 急停落在这一句的哪里（实际播出的占全句的比例）。 */
  position: number | null;
}

/** 把每轮与录音里的句段对上：按页面开始播的时刻换算到录像时间线，取最近的句段。 */
async function measure(path: string, recordWall: number, trials: Trial[]) {
  const analysis = await analyzeSegments(path, { toneHz: TONE_HZ, timeline: true });
  const segments = analysis.segments.listed;
  const sentenceSeconds = ([...TEXT].length * SAMPLES_PER_CHAR) / SAMPLE_RATE;
  const measured: Measured[] = trials.map((trial) => {
    const empty = {
      segment: null,
      heard: null,
      overSamples: null,
      overMs: null,
      afterDMs: null,
      position: null,
    };
    if (trial.startedWall === null || trial.played === null) return { ...trial, ...empty };
    const expected = (trial.startedWall - recordWall) / 1000;
    let best: (typeof segments)[number] | undefined;
    for (const segment of segments) {
      const d = Math.abs(segment.atSeconds - expected);
      if (d < 1 && (!best || d < Math.abs(best.atSeconds - expected))) best = segment;
    }
    if (!best) return { ...trial, ...empty };
    const heard = Math.round(best.seconds * SAMPLE_RATE);
    const overSamples = trial.played - heard;
    const overMs = (overSamples * 1000) / SAMPLE_RATE;
    const delayMs = trial.presentation?.delayMs;
    return {
      ...trial,
      segment: { atSeconds: best.atSeconds, seconds: best.seconds },
      heard,
      overSamples,
      overMs: Math.round(overMs * 10) / 10,
      afterDMs: delayMs === undefined ? null : Math.round((overMs - delayMs) * 10) / 10,
      position: Math.round((best.seconds / sentenceSeconds) * 1000) / 1000,
    };
  });
  const numbers = (pick: (m: Measured) => number | null) =>
    measured.map(pick).filter((v): v is number => typeof v === 'number');
  return {
    trials: measured,
    overMs: summarize(numbers((m) => m.overMs)),
    delayMs: summarize(numbers((m) => m.presentation?.delayMs ?? null)),
    afterDMs: summarize(numbers((m) => m.afterDMs)),
    absAfterDMs: summarize(numbers((m) => (m.afterDMs === null ? null : Math.abs(m.afterDMs)))),
    emergencyMs: summarize(numbers((m) => m.emergencyMs)),
    segments: segments.length,
    spikes: analysis.spikes.count,
  };
}

/** 从宿主日志补齐每轮的页面回报：急停之后的第一条 stage.sentence。 */
function fillFromLog(lines: LogLine[], trial: Trial): void {
  const estop = Date.parse(trial.estopAt);
  const sentence = lines.find(
    (l) => l.event === 'stage.sentence' && Date.parse(l.t) >= estop && l.complete === false,
  );
  if (sentence) {
    trial.sentenceId = String(sentence.sentenceId);
    trial.played = sentence.played as number;
    trial.reason = (sentence.reason as string | undefined) ?? null;
    const startedAt = sentence.startedAt as number | null;
    const endedAt = sentence.endedAt as number;
    trial.startedWall = startedAt === null ? null : Date.parse(sentence.t) - (endedAt - startedAt);
  }
  const fact = (type: string) =>
    lines.find((l) => l.event === 'fact' && l.type === type && Date.parse(l.t) >= estop - 50);
  const requested = fact('safety.emergency-requested');
  const completed = fact('safety.emergency-completed');
  if (requested && completed) trial.emergencyMs = Date.parse(completed.t) - Date.parse(requested.t);
}

async function reanalyze(prefix: string): Promise<void> {
  const report = JSON.parse(readFileSync(`${prefix}.json`, 'utf8')) as {
    recording?: { path: string; startWall: number };
    trials: Trial[];
    [key: string]: unknown;
  };
  if (!report.recording) throw new Error('结果里没有录制文件');
  report.result = await measure(report.recording.path, report.recording.startWall, report.trials);
  report.reanalyzedAt = new Date().toISOString();
  writeFileSync(`${prefix}.json`, `${JSON.stringify(report, null, 2)}\n`);
  say(`已重做分析：${prefix}.json`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'stage-source': { type: 'string' },
      'safe-scene': { type: 'string', default: 'Safe' },
      trials: { type: 'string', default: '12' },
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
  const count = Number(values.trials);
  if (!(Number.isInteger(count) && count >= 2)) throw new Error('--trials 为不小于 2 的整数');
  const started = new Date().toISOString();
  const out = resolve(
    values.out ?? join('reports', `drill-estop-writeback-${started.replace(/[:.]/g, '-')}`),
  );

  await waitForNoOtherBellis({ log: say });
  const secret = await readObsSecret(new KeyringSecretStore('bellis'), OBS_SECRET);
  const obs = await ObsClient.connect(secret.url, secret.password);
  const meter = new Meter(stageSource);
  const meters = await ObsMeters.connect(secret.url, secret.password, (r) => meter.update(r));
  const service = `bellis-drill-${randomBytes(4).toString('hex')}`;
  const store = new KeyringSecretStore(service);
  const configPath = join(tmpdir(), `${service}.json`);
  const profilePath = join(tmpdir(), `${service}.profile.json`);
  const storePath = join(tmpdir(), `${service}.db`);
  let original: ObsSnapshot | undefined;
  let session: Session | undefined;
  let host: Lines | undefined;
  let recording = false;
  let recordingPath: string | undefined;
  let recordWall = 0;
  const trials: Trial[] = [];
  const result: Record<string, unknown> = {};
  try {
    if (ok(await obs.request('GetStreamStatus')).outputActive)
      throw new Error('推流进行中，拒绝运行');
    if (ok(await obs.request('GetRecordStatus')).outputActive)
      throw new Error('录制进行中，拒绝运行');
    result.obsVersion = ok(await obs.request('GetVersion')).obsVersion;
    // 录像的音轨是不是观众听到的那条混音：简单输出模式、录像质量与推流相同时，两者共用同一个音频编码器。
    const parameter = async (category: string, name: string) => {
      const answer = await obs.request('GetProfileParameter', {
        parameterCategory: category,
        parameterName: name,
      });
      return answer.ok ? (answer.data?.parameterValue ?? null) : null;
    };
    result.output = {
      mode: await parameter('Output', 'Mode'),
      simpleRecQuality: await parameter('SimpleOutput', 'RecQuality'),
      advancedRecTracks: await parameter('AdvOut', 'RecTracks'),
      advancedTrackIndex: await parameter('AdvOut', 'TrackIndex'),
    };
    say(`输出设置：${JSON.stringify(result.output)}`);
    original = await snapshot(obs, stageSource, safeScene);
    const live = original.programScene;
    if (live === safeScene) throw new Error('节目场景已经是安全场景');
    if (original.safeItems.some((i) => i.sourceName === stageSource))
      throw new Error(`安全场景「${safeScene}」里有 Stage 源`);
    ok(await obs.request('SetInputMute', { inputName: stageSource, inputMuted: false }));
    await writeObsSecret(store, secret, OBS_SECRET);

    const horizon = FIRST_AT_MS + (count + 10) * 3 * ANNOUNCE_EVERY_MS;
    const announcements = Array.from(
      { length: Math.ceil(horizon / ANNOUNCE_EVERY_MS) },
      (_, i) => ({ id: `estop${i}`, atMs: FIRST_AT_MS + i * ANNOUNCE_EVERY_MS, text: TEXT }),
    );
    writeFileSync(
      profilePath,
      JSON.stringify({
        name: 'drill-estop-writeback',
        packs: [
          {
            name: 'all',
            entries: [
              { id: 'obs', plugin: 'obs-control', grant: ['obs.control'] },
              { id: 'stage-page', plugin: 'stage-page-obs', grant: ['obs.stage-url'] },
              { id: 'stage', plugin: 'stage-service' },
              { id: 'stage-sync', plugin: 'stage-sync', grant: ['obs.meters'] },
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
              { id: 'schedule', plugin: 'speech-schedule', config: { announcements, ttlMs: 2000 } },
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
    await call(OperatorMethod.Presence);
    for (const deadline = Date.now() + 20_000; ; ) {
      const failures = (await call(OperatorMethod.Preflight, { target: 'M2' }))
        .failures as string[];
      if (failures.length === 0) break;
      if (Date.now() > deadline) throw new Error(`预检未通过：${failures.join('；')}`);
      await sleep(250);
    }

    ok(await obs.request('StartRecord'));
    recordWall = Date.now();
    recording = true;
    say('录制开始');
    await sleep(1000);

    for (let index = 0; index < count; index++) {
      // 上一轮急停后在安全场景且静音：像操作员一样切回直播场景、取消静音，再进 M2。
      ok(await obs.request('SetCurrentProgramScene', { sceneName: live }));
      ok(await obs.request('SetInputMute', { inputName: stageSource, inputMuted: false }));
      await call(OperatorMethod.Presence);
      const m2 = await call(OperatorMethod.Mode, { target: 'M2' });
      if (m2.ok !== true) throw new Error(`进入 M2 失败：${JSON.stringify(m2)}`);
      const plannedMs = Math.round(EARLIEST_MS + ((LATEST_MS - EARLIEST_MS) * index) / (count - 1));
      const soundAt = await meter.until((db) => db > SOUND_DB, 3 * ANNOUNCE_EVERY_MS, Date.now());
      await sleep(Math.max(0, soundAt + plannedMs - Date.now()));
      const status = await call(OperatorMethod.Status);
      const presentation = (status.presentation ?? null) as Trial['presentation'];
      const estopAt = Date.now();
      const answer = (await call(OperatorMethod.EmergencyStop, {
        reason: `演练：急停写回 #${index + 1}`,
      })) as { obs?: { ok?: boolean } };
      const trial: Trial = {
        index: index + 1,
        plannedMs,
        presentation,
        soundAt: new Date(soundAt).toISOString(),
        estopAt: new Date(estopAt).toISOString(),
        obsOk: answer.obs?.ok ?? null,
        sentenceId: null,
        played: null,
        reason: null,
        startedWall: null,
        emergencyMs: null,
      };
      trials.push(trial);
      await lines
        .wait(
          (l) => l.event === 'stage.sentence' && Date.parse(l.t) >= estopAt && l.complete === false,
          5000,
        )
        .catch(() => undefined);
      await sleep(300);
      fillFromLog(lines.items, trial);
      say(
        `#${trial.index}：计划 ${plannedMs}ms，D=${presentation?.delayMs ?? '?'}，played=${trial.played}，OBS ${trial.obsOk ? '成功' : '失败'}`,
      );
      // 安全场景里留出一段静音，录音里句段分得开。
      await sleep(1500);
    }

    recordingPath = ok(await obs.request('StopRecord')).outputPath as string;
    recording = false;
    for (let size = -1; ; ) {
      await sleep(1000);
      const active = ok(await obs.request('GetRecordStatus')).outputActive;
      const now = statSync(recordingPath).size;
      if (!active && now === size) break;
      size = now;
    }
    say(`录制已停止：${recordingPath}`);
    operator.connection.close();
    result.recording = {
      path: recordingPath,
      bytes: statSync(recordingPath).size,
      startWall: recordWall,
    };
    say('分析录音……');
    result.result = await measure(recordingPath, recordWall, trials);
  } catch (error) {
    result.error = (error as Error).stack ?? String(error);
    say(`实测中止：${(error as Error).message}`);
  } finally {
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
    `${JSON.stringify({ drill: 'estop-writeback', started, finished: new Date().toISOString(), node: process.version, stageSource, safeScene, text: TEXT, trials, ...result }, null, 2)}\n`,
  );
  say(`结果已写入 ${out}.json`);
}

await main();
