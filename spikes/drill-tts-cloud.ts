/**
 * P1 出口“云端 TTS”的真机演练：云端 TTS 经 TTS 路由与真实 Stage 在 OBS 中播出，主备切换与只出字幕的降级各一次。
 *
 *   node spikes/drill-tts-cloud.ts --stage-source 名字 --minimax-voice 音色ID --volcengine-speaker 音色ID
 *        [--minimax-model speech-2.8-turbo] [--volcengine-resource-id seed-tts-2.0] [--primary minimax]
 *        [--retry-after-ms 15000] [--every-ms 12000] [--safe-scene Safe] [--out 结果文件前缀]
 *
 * 用启动器拉起真实宿主与看门狗，凭据服务就是 SecretStore 服务名 bellis（宿主按 profile 授予的 secret:minimax、
 * secret:volcengine 在进程内读取，不复制）。profile 含 OBS 控制、真实 Stage、TTS 路由（cloud、subtitles，不用本地 TTS）、
 * 两家都开启外发的云端 TTS（主备按 --primary）、发声仲裁与每 every-ms 一句的定时播报，审核显式关闭。
 *
 * 主厂商“不可用”用网络故障注入（drill-faults.ts，预加载进宿主进程）：到该厂商主机的 TLS 连接被拒、已有的连接被断开，
 * 不改配置、凭据与系统设置，去掉后即恢复。进入 M2 之后的第 j 句：
 *   1–4  正常：主厂商出声；记到点到 Stage 开始播、到首个游标、到音量表出声的时间；
 *   5–6  断开主厂商：第 5 句改用备用厂商出声，记 tts.switched 与给操作员的提示；第 6 句在冷却期内直接用备用；
 *   7    恢复主厂商（冷却期已过）：换回主厂商，记 tts.switched（恢复可用）；
 *   8–9  两家都断开：路由改为只出字幕（字幕照常、音量表无声），记 tts.switched；第 9 句云端仍未就绪；
 *   10   两家都恢复（冷却期已过）：路由换回云端并出声，记 tts.switched；
 *   11   正常。
 * 第 1 句与第 8 句播出中各截一张 Stage 源的画面，核对字幕照常显示。
 *
 * 会改写浏览器源的 URL、切换节目场景并静音；推流或录制进行中、有别的 Bellis 进程或本地 TTS sidecar 在运行时拒绝运行。
 * 结束时恢复浏览器源设置（含 URL）、场景与静音，整体读回比对。只发送下面的固定播报文本。
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { connect, decodeSessionKey, RpcPeer } from '@bellis/channel';
import { loadConfig, OBS_SECRET, readObsSecret } from '@bellis/config';
import { launch, type Session } from '@bellis/launcher';
import { ObsClient, type ObsResult } from '@bellis/obs';
import { OperatorMethod, Role } from '@bellis/protocol';
import { KeyringSecretStore } from '@bellis/secret-store';
import { MINIMAX_ENDPOINT, VOLCENGINE_ENDPOINT } from '@bellis/tts-cloud';
import { waitForNoOtherBellis } from './bellis-processes.ts';
import { differences, type ObsSnapshot, restoreSnapshot, snapshot } from './obs-snapshot.ts';
import { type MeterReading, ObsMeters } from './s01-stage/meters.ts';

const file = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const hostMain = file('../packages/host/src/main.ts');
const watchdogMain = file('../packages/watchdog/src/main.ts');
const faultsModule = file('./drill-faults.ts');
const liveExample = file('../config/live.example.json');
const SOUND_DB = -40;
const FIRST_AT_MS = 30_000;
const SENTENCES = 11;
const TEXTS = [
  '大家好，欢迎来到今天的直播。',
  '接下来我们一起看看今天的安排。',
  '如果你是第一次来，可以先点个关注。',
  '今天的天气不错，适合出门走走。',
  '感谢大家的陪伴，我们继续往下看。',
  '这一段我们先放慢一点。',
  '好，现在继续刚才的话题。',
  '稍等一下，马上回来。',
  '我们准备进入下一个环节。',
  '谢谢大家，我们接着往下聊。',
  '今天就先说到这里吧。',
];
const HOSTS = {
  minimax: new URL(MINIMAX_ENDPOINT).hostname,
  volcengine: new URL(VOLCENGINE_ENDPOINT).hostname,
};
type Vendor = keyof typeof HOSTS;

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
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const r = (v: number | undefined) => (v === undefined ? null : Math.round(v * 10) / 10);
  return {
    n: sorted.length,
    min: r(sorted[0]),
    p50: r(at(0.5)),
    p95: r(at(0.95)),
    max: r(sorted.at(-1)),
  };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const say = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
const fact = (type: string) => (line: LogLine) => line.event === 'fact' && line.type === type;
const at = (line: LogLine) => Date.parse(line.t);

/** 本地 TTS sidecar（Python 的 tts_local）是否在运行：只读进程列表里的命令行。 */
function ttsLocalRunning(): string[] {
  const out = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*tts_local*' }).ProcessId`,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  return out.stdout.split(/\s+/).filter(Boolean);
}

/** 截取 Stage 源的画面写成 PNG。只读。 */
async function screenshot(obs: ObsClient, sourceName: string, out: string): Promise<string> {
  const shot = ok(await obs.request('GetSourceScreenshot', { sourceName, imageFormat: 'png' }));
  const data = String(shot.imageData ?? '');
  const comma = data.indexOf(',');
  writeFileSync(out, Buffer.from(comma >= 0 ? data.slice(comma + 1) : data, 'base64'));
  return out;
}

/** 第 j 句（从 1 起）之前要断开的厂商。 */
function blockedFor(j: number, primary: Vendor, fallback: Vendor): Vendor[] {
  if (j === 5 || j === 6) return [primary];
  if (j === 8 || j === 9) return [primary, fallback];
  return [];
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'stage-source': { type: 'string' },
      'safe-scene': { type: 'string', default: 'Safe' },
      'minimax-model': { type: 'string', default: 'speech-2.8-turbo' },
      'minimax-voice': { type: 'string' },
      'volcengine-resource-id': { type: 'string', default: 'seed-tts-2.0' },
      'volcengine-speaker': { type: 'string' },
      primary: { type: 'string', default: 'minimax' },
      'retry-after-ms': { type: 'string', default: '15000' },
      'every-ms': { type: 'string', default: '12000' },
      out: { type: 'string' },
    },
  });
  const stageSource = values['stage-source'];
  if (!stageSource) throw new Error('需要 --stage-source');
  if (!values['minimax-voice'] || !values['volcengine-speaker']) {
    throw new Error('需要 --minimax-voice 与 --volcengine-speaker');
  }
  const primary = values.primary as Vendor;
  if (primary !== 'minimax' && primary !== 'volcengine')
    throw new Error('--primary 只能是 minimax 或 volcengine');
  const fallback: Vendor = primary === 'minimax' ? 'volcengine' : 'minimax';
  const safeScene = values['safe-scene'];
  const retryAfterMs = Number(values['retry-after-ms']);
  const everyMs = Number(values['every-ms']);
  if (everyMs * 2 <= retryAfterMs)
    throw new Error('--every-ms 的两倍须大于 --retry-after-ms，恢复的那一句才在冷却期满之后');
  const started = new Date().toISOString();
  const out = resolve(values.out ?? join('reports', `drill-tts-cloud-${started.slice(0, 10)}`));
  mkdirSync(dirname(out), { recursive: true });

  await waitForNoOtherBellis({ log: say });
  const local = ttsLocalRunning();
  if (local.length > 0)
    throw new Error(`本地 TTS sidecar 在运行（${local.join(', ')}），请稍后再试`);
  const secret = await readObsSecret(new KeyringSecretStore('bellis'), OBS_SECRET);
  const obs = await ObsClient.connect(secret.url, secret.password);
  /** Stage 源每次音量表读数的时刻与峰值。 */
  const stage: Array<[number, number]> = [];
  const meters = await ObsMeters.connect(
    secret.url,
    secret.password,
    (readings: MeterReading[]) => {
      const now = Date.now();
      for (const r of readings) if (r.name === stageSource) stage.push([now, r.peakDb]);
    },
  );
  const loudBetween = (from: number, to: number) =>
    stage.filter(([t, db]) => t >= from && t < to && db > SOUND_DB).length;
  const firstLoud = (from: number, to: number) =>
    stage.find(([t, db]) => t >= from && t < to && db > SOUND_DB)?.[0];

  const tag = randomBytes(4).toString('hex');
  const configPath = join(tmpdir(), `bellis-drill-${tag}.json`);
  const profilePath = join(tmpdir(), `bellis-drill-${tag}.profile.json`);
  const faultsPath = join(tmpdir(), `bellis-drill-${tag}.faults.json`);
  const storePath = join(tmpdir(), `bellis-drill-${tag}.db`);
  const setFaults = (hosts: string[]) =>
    writeFileSync(faultsPath, JSON.stringify({ block: hosts }));
  setFaults([]);
  let original: ObsSnapshot | undefined;
  let session: Session | undefined;
  let host: Lines | undefined;
  const result: Record<string, unknown> = {};
  try {
    if (ok(await obs.request('GetStreamStatus')).outputActive)
      throw new Error('推流进行中，拒绝运行');
    if (ok(await obs.request('GetRecordStatus')).outputActive)
      throw new Error('录制进行中，拒绝运行');
    result.obsVersion = ok(await obs.request('GetVersion')).obsVersion;
    original = await snapshot(obs, stageSource, safeScene);
    if (original.programScene === safeScene) throw new Error('节目场景已经是安全场景');
    ok(await obs.request('SetInputMute', { inputName: stageSource, inputMuted: false }));

    const announcements = Array.from({ length: 40 }, (_, i) => ({
      id: `a${i}`,
      atMs: FIRST_AT_MS + i * everyMs,
      text: TEXTS[i % TEXTS.length] as string,
    }));
    const byId = (id: string) => announcements.find((a) => `scheduled:${a.id}` === id);
    const cloudConfig = {
      primary,
      fallback: [fallback],
      retryAfterMs,
      minimax: {
        egress: true,
        endpoint: MINIMAX_ENDPOINT,
        model: values['minimax-model'],
        voiceId: values['minimax-voice'],
        sampleRate: 24_000,
        languageBoost: 'Chinese',
      },
      volcengine: {
        egress: true,
        endpoint: VOLCENGINE_ENDPOINT,
        resourceId: values['volcengine-resource-id'],
        speaker: values['volcengine-speaker'],
        sampleRate: 24_000,
        timestamps: 'subtitle',
      },
    };
    result.profile = { order: ['cloud', 'subtitles'], cloud: cloudConfig };
    writeFileSync(
      profilePath,
      JSON.stringify({
        name: 'drill-tts-cloud',
        packs: [
          {
            name: 'all',
            entries: [
              { id: 'obs', plugin: 'obs-control', grant: ['obs.control'] },
              { id: 'stage-page', plugin: 'stage-page-obs', grant: ['obs.stage-url'] },
              { id: 'stage', plugin: 'stage-service' },
              { id: 'tts', plugin: 'tts-router', config: { order: ['cloud', 'subtitles'] } },
              {
                id: 'tts-cloud',
                plugin: 'tts-cloud',
                grant: [
                  `net.egress:${HOSTS.minimax}`,
                  `net.egress:${HOSTS.volcengine}`,
                  'secret:minimax',
                  'secret:volcengine',
                ],
                config: cloudConfig,
              },
              { id: 'speech', plugin: 'speech-arbiter', grant: ['speech.output'] },
              {
                id: 'schedule',
                plugin: 'speech-schedule',
                config: { announcements, ttlMs: everyMs },
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

    const launchedAt = Date.now();
    session = await launch({
      configPath,
      secretService: 'bellis',
      host: {
        command: process.execPath,
        args: [
          '--import',
          `${pathToFileURL(faultsModule).href}?state=${encodeURIComponent(faultsPath)}`,
          hostMain,
        ],
      },
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
    const preflight = async () =>
      ((await call(OperatorMethod.Preflight, { target: 'M2' })).failures as string[]) ?? [];

    const scheduleActive = await lines.wait(
      (l) => l.event === 'plugin.transition' && l.entryId === 'schedule' && l.to === 'active',
      60_000,
    );
    const scheduleStart = at(scheduleActive);
    const dueOf = (id: string) => scheduleStart + (byId(id)?.atMs ?? Number.NaN);
    await call(OperatorMethod.Presence);
    const seen: string[][] = [];
    const deadline = Date.now() + 60_000;
    for (;;) {
      const failures = await preflight();
      if (failures.length === 0) break;
      if (seen.at(-1)?.join('；') !== failures.join('；')) seen.push(failures);
      if (Date.now() > deadline) throw new Error(`预检未通过：${failures.join('；')}`);
      await sleep(300);
    }
    result.startup = { preflightPassedAfterLaunchMs: Date.now() - launchedAt, failuresSeen: seen };
    const m2 = await call(OperatorMethod.Mode, { target: 'M2' });
    if (m2.ok !== true) throw new Error(`进入 M2 失败：${JSON.stringify(m2)}`);
    const m2At = Date.now();
    say('已进入 M2');

    // 进入 M2 之后到点的第一句。
    const firstIndex = announcements.findIndex((a) => scheduleStart + a.atMs >= m2At + 1000);
    const sentences: Array<Record<string, unknown>> = [];
    let from = lines.items.length;
    for (let j = 1; j <= SENTENCES; j++) {
      const announcement = announcements[firstIndex + j - 1];
      if (!announcement) throw new Error('播报不够');
      const id = `scheduled:${announcement.id}`;
      const dueAt = scheduleStart + announcement.atMs;
      const blocked = blockedFor(j, primary, fallback);
      setFaults(blocked.map((v) => HOSTS[v]));
      const faultsAt = Date.now();
      if (j === 1 || j === 8) {
        const shotAt = dueAt + 1800;
        void (async () => {
          await sleep(Math.max(0, shotAt - Date.now()));
          try {
            await screenshot(obs, stageSource, `${out}-${j === 1 ? 'voiced' : 'subtitles'}.png`);
          } catch (error) {
            say(`截图失败：${(error as Error).message}`);
          }
        })();
      }
      const played = await lines.wait(
        (l) => fact('utterance.played')(l) && (l.data as { id?: string }).id === id,
        everyMs * 3,
        from,
      );
      from = lines.items.indexOf(played) + 1;
      const data = played.data as {
        heard: string;
        end: string;
        reason?: string;
        skipped: unknown[];
      };
      const endAt = at(played);
      const window = lines.items.filter((l) => at(l) >= dueAt - 50 && at(l) <= endAt + 50);
      const stageLine = window.find(
        (l) => l.event === 'stage.sentence' && String(l.sentenceId).startsWith(id),
      );
      const wall = (t: unknown) =>
        stageLine && typeof t === 'number'
          ? at(stageLine) - ((stageLine.endedAt as number) - t)
          : undefined;
      const startedWall = wall(stageLine?.startedAt);
      const firstCursor = stageLine?.firstCursor as [number, number] | null | undefined;
      const cursorWall = firstCursor ? wall(firstCursor[0]) : undefined;
      const sound = firstLoud(dueAt, endAt + 200);
      const switched = window
        .filter((l) => l.event === 'tts.switched')
        .map((l) => ({ entry: l.entry, from: l.from, to: l.to, reason: l.reason, hint: l.hint }));
      const failed = window
        .filter((l) => l.event === 'tts.engine-failed' || l.event === 'tts.engine-unavailable')
        .map((l) => ({ event: l.event, engine: l.engine, reason: l.reason }));
      const summary = {
        j,
        id,
        text: announcement.text,
        blocked,
        faultsSetBeforeDueMs: dueAt - faultsAt,
        heard: data.heard,
        end: data.end,
        reason: data.reason ?? null,
        played: stageLine?.played ?? null,
        complete: stageLine?.complete ?? null,
        dueToStageStartedMs: startedWall === undefined ? null : startedWall - dueAt,
        dueToFirstCursorMs: cursorWall === undefined ? null : cursorWall - dueAt,
        firstCursorPlayed: firstCursor?.[1] ?? null,
        dueToFirstSoundMs: sound === undefined ? null : sound - dueAt,
        loudReadings: loudBetween(dueAt, endAt + 200),
        meterReadings: stage.filter(([t]) => t >= dueAt && t < endAt + 200).length,
        switched,
        failed,
        connected: window
          .filter((l) => l.event === 'tts.connected' || l.event === 'tts.connection-closed')
          .map((l) => ({ event: l.event, engine: l.engine, reason: l.reason ?? null })),
      };
      sentences.push(summary);
      say(`第 ${j} 句：${JSON.stringify(summary)}`);
      if (j === 8) result.preflightWhileBothDown = await preflight();
      if (j === 5) result.preflightWhilePrimaryDown = await preflight();
    }
    setFaults([]);
    result.sentences = sentences;
    result.switchedFacts = lines.items
      .filter(fact('tts.switched'))
      .map((l) => ({ t: l.t, ...(l.data as object) }));
    result.modeAfter = (await call(OperatorMethod.Status)).mode;
    const voiced = sentences.filter(
      (s) => (s.loudReadings as number) > 0 && s.blocked !== undefined,
    );
    result.timing = {
      note: 'M2、审核关闭、无逐句放行：到点后仲裁随即提交合成，到点约等于提交',
      dueToFirstCursorMs: summarize(
        voiced.map((s) => s.dueToFirstCursorMs as number).filter((v) => typeof v === 'number'),
      ),
      dueToFirstSoundMs: summarize(
        voiced.map((s) => s.dueToFirstSoundMs as number).filter((v) => typeof v === 'number'),
      ),
    };
    void byId;
    void dueOf;
    operator.connection.close();
  } finally {
    setFaults([]);
    await session?.stop();
    meters.close();
    if (original) {
      result.restoreFailures = await restoreSnapshot(obs, original, stageSource);
      const after = await snapshot(obs, stageSource, safeScene);
      result.obsRestored = differences(original, after);
    }
    obs.close();
    if (host) writeFileSync(`${out}.jsonl`, `${host.raw.join('\n')}\n`);
    for (const path of [configPath, profilePath, faultsPath]) rmSync(path, { force: true });
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${storePath}${suffix}`, { force: true });
  }
  writeFileSync(
    `${out}.json`,
    `${JSON.stringify({ drill: 'tts-cloud', started, finished: new Date().toISOString(), node: process.version, stageSource, safeScene, primary, fallback, retryAfterMs, everyMs, ...result }, null, 2)}\n`,
  );
  say(`结果已写入 ${out}.json`);
}

await main();
