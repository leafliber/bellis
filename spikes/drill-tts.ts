/**
 * P1 第 5、6 步的真机验证：本地 Qwen3-TTS 经 TTS 路由与真实 Stage 在 OBS 中播出。
 *
 *   node spikes/drill-tts.ts --stage-source 名字 [--safe-scene Safe] [--speaker vivian] [--out 结果文件]
 *
 * 前提：本 worktree 已 `uv sync --locked --group tts-local`，模型权重已在 Hugging Face 缓存里。
 * 用启动器拉起真实宿主与看门狗。profile 含 OBS 控制、真实 Stage、TTS 路由（local、subtitles）、
 * qwen3 后端的本地 TTS、发声仲裁与每 15 秒一句的定时播报，审核显式关闭。依次核对：
 *   1. 模型加载期间开播预检列出“TTS 主引擎 local 未就绪”，加载完成后通过；记下模型就绪的时间。
 *   2. M2：两句经真实页面完整播出，记下到点到首次出声的时间与写回的文本。
 *   3. 强制终止 sidecar：记 tts.degraded，它派生的进程随之退出；下一句改为只出字幕（音量表无声），
 *      tts@1 不消失、不急停；重新就绪后换回本地并有声。
 *   4. 播放中急停：记下急停到音量表无声的时间，写回的文本只含真实 Stage 回报已播出的部分。
 *
 * 会改写浏览器源的 URL、切换节目场景并静音；推流或录制进行中时拒绝运行，结束后恢复。
 * 用临时的 SecretStore 服务名存放会话信息与 OBS 凭据副本，结束时删除。
 */
import { spawnSync } from 'node:child_process';
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
import { type MeterReading, ObsMeters } from './s01-stage/meters.ts';

const file = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const hostMain = file('../packages/host/src/main.ts');
const watchdogMain = file('../packages/watchdog/src/main.ts');
const liveExample = file('../config/live.example.json');
const SOUND_DB = -40;
const QUIET_DB = -60;
const EVERY_MS = 15_000;
const FIRST_AT_MS = 30_000;
const TEXTS = [
  '大家好，欢迎来到今天的直播。',
  '接下来我们一起看看今天的安排。',
  '如果你是第一次来，可以先点个关注。',
  '今天的天气不错，适合出门走走。',
  '感谢大家的陪伴，我们继续往下看。',
];

type LogLine = { t: string; event: string; [field: string]: unknown };

class Lines {
  readonly items: LogLine[] = [];
  readonly #waiters = new Set<() => void>();

  constructor(stream: Readable | null) {
    if (!stream) throw new Error('没有可读的输出');
    createInterface({ input: stream }).on('line', (line) => {
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
const fact = (type: string) => (line: LogLine) => line.event === 'fact' && line.type === type;
const at = (line: LogLine) => Date.parse(line.t);

/** 进程的直接子进程 PID（Windows）。 */
function children(pid: number): number[] {
  const out = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}").ProcessId`,
    ],
    { encoding: 'utf8' },
  );
  return out.stdout
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'stage-source': { type: 'string' },
      'safe-scene': { type: 'string', default: 'Safe' },
      speaker: { type: 'string', default: 'vivian' },
      /** 诊断用：fake 后端按码点出正弦测试音，可设首包延迟与块长。 */
      backend: { type: 'string', default: 'qwen3' },
      'first-delay-ms': { type: 'string', default: '0' },
      'host-log': { type: 'string' },
      out: { type: 'string' },
    },
  });
  const stageSource = values['stage-source'];
  if (!stageSource) throw new Error('需要 --stage-source');
  const safeScene = values['safe-scene'];

  const secret = await readObsSecret(new KeyringSecretStore('bellis'), OBS_SECRET);
  const obs = await ObsClient.connect(secret.url, secret.password);
  /** Stage 源每次音量表读数的时刻与峰值；其它输入有声的读数另计。 */
  const stage: Array<[number, number]> = [];
  const others: Array<[number, string]> = [];
  const meters = await ObsMeters.connect(
    secret.url,
    secret.password,
    (readings: MeterReading[]) => {
      const now = Date.now();
      for (const r of readings) {
        if (r.name === stageSource) stage.push([now, r.peakDb]);
        else if (r.peakDb > SOUND_DB) others.push([now, r.name]);
      }
    },
  );
  const loudBetween = (from: number, to: number) =>
    stage.filter(([t, db]) => t >= from && t < to && db > SOUND_DB).length;
  const firstLoud = (from: number) => stage.find(([t, db]) => t >= from && db > SOUND_DB)?.[0];
  const firstQuiet = (from: number) => stage.find(([t, db]) => t >= from && db < QUIET_DB)?.[0];
  const service = `bellis-drill-${randomBytes(4).toString('hex')}`;
  const store = new KeyringSecretStore(service);
  const configPath = join(tmpdir(), `${service}.json`);
  const profilePath = join(tmpdir(), `${service}.profile.json`);
  const started = new Date().toISOString();
  let original: { scene: string; muted: boolean; settings: Record<string, unknown> } | undefined;
  let session: Session | undefined;
  const result: Record<string, unknown> = {};
  try {
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
    ok(await obs.request('SetInputMute', { inputName: stageSource, inputMuted: false }));

    await writeObsSecret(store, secret, OBS_SECRET);
    const announcements = Array.from({ length: 40 }, (_, i) => ({
      id: `a${i}`,
      atMs: FIRST_AT_MS + i * EVERY_MS,
      text: TEXTS[i % TEXTS.length] as string,
    }));
    const textOf = (id: string) => announcements.find((a) => `scheduled:${a.id}` === id)?.text;
    const atMsOf = (id: string) => announcements.find((a) => `scheduled:${a.id}` === id)?.atMs;
    writeFileSync(
      profilePath,
      JSON.stringify({
        name: 'drill-tts',
        packs: [
          {
            name: 'all',
            entries: [
              { id: 'obs', plugin: 'obs-control', grant: ['obs.control'] },
              { id: 'stage-page', plugin: 'stage-page-obs', grant: ['obs.stage-url'] },
              { id: 'stage', plugin: 'stage-service' },
              { id: 'tts', plugin: 'tts-router', config: { order: ['local', 'subtitles'] } },
              {
                id: 'tts-local',
                plugin: 'tts-local',
                config: {
                  backend: values.backend,
                  qwen3: { speaker: values.speaker, language: 'chinese' },
                  fake: {
                    toneHz: 440,
                    chunkSamples: 2400,
                    firstChunkDelayMs: Number(values['first-delay-ms']),
                  },
                },
              },
              { id: 'speech', plugin: 'speech-arbiter', grant: ['speech.output'] },
              {
                id: 'schedule',
                plugin: 'speech-schedule',
                config: { announcements, ttlMs: 12_000 },
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
    config.storePath = join(tmpdir(), `${service}.db`);
    writeFileSync(configPath, JSON.stringify(config));

    const launchedAt = Date.now();
    session = await launch({
      configPath,
      secretService: service,
      host: { command: process.execPath, args: [hostMain] },
      watchdog: { command: process.execPath, args: [watchdogMain] },
      stdout: 'pipe',
    });
    const host = new Lines(session.host.stdout);
    const hostLog = values['host-log'];
    if (hostLog) {
      process.on('exit', () =>
        writeFileSync(hostLog, host.items.map((l) => JSON.stringify(l)).join('\n')),
      );
    }
    void new Lines(session.watchdog.stdout);
    const key = decodeSessionKey(session.info.channelKey);
    const operator = new RpcPeer(await connect(session.info.channelPath, Role.Operator, { key }), {
      timeoutMs: 10_000,
    });
    const call = (method: string, params: Record<string, unknown> = {}) =>
      operator.request(method, params) as Promise<Record<string, unknown>>;
    const preflight = async () =>
      ((await call(OperatorMethod.Preflight, { target: 'M2' })).failures as string[]) ?? [];

    // 1. 模型加载期间预检列出 TTS 未就绪，加载完成后通过。
    const scheduleActive = await host.wait(
      (l) => l.event === 'plugin.transition' && l.entryId === 'schedule' && l.to === 'active',
      60_000,
    );
    const scheduleStart = at(scheduleActive);
    const ready = await host.wait((l) => l.event === 'tts-local.ready', 60_000);
    const firstPid = ready.pid as number;
    // M2 的预检含在场确认（安全核的前置条件），先确认在场再等预检通过。
    await call(OperatorMethod.Presence);
    const seen: string[][] = [];
    const deadline = Date.now() + 180_000;
    for (;;) {
      const failures = await preflight();
      if (failures.length === 0) break;
      if (seen.length === 0 || seen.at(-1)?.join('；') !== failures.join('；')) seen.push(failures);
      if (Date.now() > deadline) throw new Error(`预检未通过：${failures.join('；')}`);
      await sleep(300);
    }
    const passedAt = Date.now();
    const started1 = await host.wait(fact('tts.started'), 1000);
    result.loading = {
      pluginReadyAfterLaunchMs: at(ready) - launchedAt,
      modelReadyAfterLaunchMs: at(started1) - launchedAt,
      preflightPassedAfterLaunchMs: passedAt - launchedAt,
      failuresSeen: seen,
      ttsStarted: started1.data,
    };
    console.log('加载：', JSON.stringify(result.loading));

    const m2 = await call(OperatorMethod.Mode, { target: 'M2' });
    if (m2.ok !== true) throw new Error(`进入 M2 失败：${JSON.stringify(m2)}`);
    const m2At = Date.now();

    /** 上一句播放结束的时刻：到点时上一句还在播的，只从它结束之后找这一句的声音。 */
    let lastEnd = 0;
    /** 等下一句（M2 之后到点的）播放结束，并按音量表量出到点到首次出声的时间。 */
    const nextPlayed = async (from: number, timeoutMs = EVERY_MS * 3) => {
      const line = await host.wait(
        (l) =>
          fact('utterance.played')(l) && (l.data as { source?: string }).source === 'scheduled',
        timeoutMs,
        from,
      );
      const data = line.data as { id: string; heard: string; end: string; skipped: unknown[] };
      const dueAt = scheduleStart + (atMsOf(data.id) ?? Number.NaN);
      const window = Math.max(dueAt, lastEnd + 100);
      const sound = firstLoud(window);
      const endAt = at(line);
      lastEnd = endAt;
      return {
        line,
        summary: {
          id: data.id,
          text: textOf(data.id),
          heard: data.heard,
          end: data.end,
          skipped: data.skipped,
          dueToFirstSoundMs: sound !== undefined && sound < endAt ? sound - dueAt : null,
          /** 到点时上一句还没播完：到点到出声的时间含等待上一句的部分。 */
          queuedBehindPrevious: window > dueAt,
          loudReadings: loudBetween(window, endAt + 200),
          maxPeakDb: Math.max(
            -999,
            ...stage.filter(([t]) => t >= window && t < endAt + 200).map(([, db]) => db ?? -999),
          ),
          meterReadings: stage.filter(([t]) => t >= window && t < endAt + 200).length,
          playedAfterDueMs: endAt - dueAt,
        },
      };
    };

    // 2. M2 下两句完整播出。到点早于进入 M2 的句子跳过。
    const normal: unknown[] = [];
    let from = host.items.length;
    while (normal.length < 2) {
      const { line, summary } = await nextPlayed(from);
      from = host.items.indexOf(line) + 1;
      const dueAt = scheduleStart + (atMsOf(summary.id) ?? 0);
      if (dueAt < m2At) continue;
      normal.push(summary);
      console.log('播出：', JSON.stringify(summary));
    }
    result.normal = normal;

    // 3. 强制终止 sidecar：降级为只出字幕，tts@1 不消失；重新就绪后换回本地。
    const kids = children(firstPid);
    const killAt = Date.now();
    process.kill(firstPid);
    const degraded = await host.wait(fact('tts.degraded'), 10_000, from);
    await sleep(500);
    const subtitles = await nextPlayed(host.items.length);
    from = host.items.indexOf(subtitles.line) + 1;
    const restarted = await host.wait(fact('tts.started'), 180_000, from);
    const recovered = await nextPlayed(host.items.indexOf(restarted) + 1, EVERY_MS * 4);
    const switched = host.items
      .filter(fact('tts.switched'))
      .filter((l) => at(l) >= killAt)
      .map((l) => ({ afterKillMs: at(l) - killAt, ...(l.data as object) }));
    const modeAfter = (await call(OperatorMethod.Status)).mode;
    result.crash = {
      sidecarPid: firstPid,
      childrenBefore: kids,
      childrenAliveAfter: kids.filter(alive),
      sidecarAliveAfter: alive(firstPid),
      degradedAfterKillMs: at(degraded) - killAt,
      degraded: degraded.data,
      subtitlesOnly: subtitles.summary,
      restartedAfterKillMs: at(restarted) - killAt,
      recovered: recovered.summary,
      switched,
      modeAfter,
      ttsPlugins: ((await call(OperatorMethod.Status)).plugins as Array<{ id: string }>).filter(
        (p) => p.id === 'tts' || p.id === 'tts-local' || p.id === 'speech',
      ),
    };
    console.log('崩溃演练：', JSON.stringify(result.crash));

    // 4. 播放中急停：写回只含已播出的部分。
    // 等下一句从无声开始出声，出声约 1.2 秒后急停。
    const waitFrom = Date.now();
    const onset = () => {
      for (let i = 1; i < stage.length; i++) {
        const [t, db] = stage[i] as [number, number];
        if (t >= waitFrom && db > SOUND_DB && (stage[i - 1] as [number, number])[1] <= SOUND_DB)
          return t;
      }
      return undefined;
    };
    let sound: number | undefined;
    while (sound === undefined && Date.now() < waitFrom + EVERY_MS * 2) {
      await sleep(20);
      sound = onset();
    }
    if (sound === undefined) throw new Error('等不到下一句出声');
    await sleep(1200 - (Date.now() - sound));
    const estopFrom = host.items.length;
    const estopAt = Date.now();
    await call(OperatorMethod.EmergencyStop, { reason: '演练：播放中急停' });
    const interrupted = await nextPlayed(estopFrom, 20_000);
    await sleep(1500);
    const quiet = firstQuiet(estopAt);
    result.estop = {
      soundToEstopMs: estopAt - sound,
      stopToQuietMs: quiet === undefined ? null : quiet - estopAt,
      utterance: interrupted.summary,
      loudReadingsAfter500ms: loudBetween(estopAt + 500, Date.now()),
    };
    console.log('急停：', JSON.stringify(result.estop));
    ok(await obs.request('SetCurrentProgramScene', { sceneName: original.scene }));
    ok(await obs.request('SetInputMute', { inputName: stageSource, inputMuted: false }));
    result.otherInputsLoud = [...new Set(others.map(([, name]) => name))].map((name) => ({
      name,
      readings: others.filter(([, n]) => n === name).length,
    }));
    result.switchedAll = host.items
      .filter(fact('tts.switched'))
      .map((l) => ({ t: l.t, ...(l.data as object) }));
    operator.connection.close();
  } finally {
    await session?.stop();
    meters.close();
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
    await store.delete(OBS_SECRET);
    await store.delete(SESSION_SECRET);
    for (const path of [configPath, profilePath]) rmSync(path, { force: true });
    for (const suffix of ['.db', '.db-wal', '.db-shm']) {
      rmSync(join(tmpdir(), `${service}${suffix}`), { force: true });
    }
  }
  const out = resolve(values.out ?? join('reports', `drill-tts-${started.slice(0, 10)}.json`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    `${JSON.stringify({ drill: 'tts', started, finished: new Date().toISOString(), node: process.version, stageSource, safeScene, speaker: values.speaker, ...result }, null, 2)}\n`,
  );
  console.log(`结果已写入 ${out}`);
}

await main();
