/**
 * P1 第 10 步的真机演练：开播预检逐项失败（P1 任务卡出口“开播预检任一项失败时无法进入 M1、M2”）
 * 与真实 Stage 页面的拒绝核对（出口“错误的 Host、Origin、重放的令牌与第二个会话都被拒绝”）。
 *
 *   node spikes/drill-preflight.ts --stage-source 名字 [--safe-scene Safe] [--only 项,项] [--out 结果文件]
 *
 * --only 只跑列出的项：presence、reroute、shutdown、restart、safe-scene、stage-source、safe-item、
 * stage-unauth、watchdog、rejections、playback、no-review、avatar、moderation。
 *
 * 用启动器拉起真实宿主与看门狗，profile 参照 drill-output：OBS 控制、真实 Stage、440Hz 测试音的模拟 TTS、
 * 发声仲裁、M1 放行环节、审核显式关闭。逐项制造一个失败，核对三件事：预检（操作员 RPC 与 operator 命令行）
 * 对 M1、M2 都列出这一项；切 M1、M2 都被拒（切 M2 前先确认在场，拒绝只能来自预检）；恢复后预检重新通过。
 *   - OBS 上的项：浏览器源的三项设置；安全场景改名；Stage 源改名；在安全场景里加一个 Stage 源的场景项。
 *   - Stage 页面未认证：把浏览器源的 URL 改成 about:blank，页面卸载、会话断开；恢复走宿主自己的路径，
 *     即重连时限（本演练设为 20 秒）过后重新下发带新令牌的 URL。
 *   - 安全核的前置条件（预检把它列为第一项，切换时由安全核拒绝）：看门狗未连接（终止看门狗进程，经启动器
 *     角色的 host.status 确认宿主已看到断开；主会话里启动器约 0.5 秒后重启它，另起一次不重启的会话，
 *     从容地用命令行核对）、M2 未确认在场（会话开始时尚未确认）。
 *   - profile 变体，各起一次会话：审核开关未显式设置（宿主拒绝启动）、M1 没有放行环节、
 *     启用了 VTube Studio 形象但 VTS 不在（核对挡住 M1、M2，且重连不刷屏）。
 *   - TTS 就绪一项要等 TTS 路由合入，记为 PENDING。
 * 之后在会话进行中对 stage-page-obs 的端口发送错误的 Host、错误的 Origin、缺少 Origin 的非顶层请求、
 * 第二个会话与重放的令牌，核对都被拒且现有会话不受影响；再在没有会话时（URL 改成 about:blank）重放令牌，
 * 核对令牌本身被拒、宿主重新下发后页面重新认证；最后切 M2 核对照常播出。
 *
 * 只做可逆的 OBS 改动：每项先记下原值，恢复后读回核对；结束时把浏览器源设置（含 URL）、场景与静音恢复原样，
 * 再整体盘点与开始时比对。推流或录制进行中、或有别的 Bellis 启动器、宿主、看门狗在运行时拒绝运行。
 * 用临时的 SecretStore 服务名存放会话信息与 OBS 凭据副本，结束时删除。浏览器源 URL 里的令牌不写进结果。
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { connect, decodeSessionKey, RpcPeer } from '@bellis/channel';
import { loadConfig, OBS_SECRET, readObsSecret, writeObsSecret } from '@bellis/config';
import { launch, type Session } from '@bellis/launcher';
import { ObsClient, type ObsResult } from '@bellis/obs';
import { ChildEnv, HostStatus, OperatorMethod, Role } from '@bellis/protocol';
import { KeyringSecretStore, SESSION_SECRET } from '@bellis/secret-store';
import { WebSocket } from 'ws';
import { waitForNoOtherBellis } from './bellis-processes.ts';
import { differences, type ObsSnapshot, restoreSnapshot, snapshot } from './obs-snapshot.ts';
import { type MeterReading, ObsMeters } from './s01-stage/meters.ts';

const file = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const hostMain = file('../packages/host/src/main.ts');
const watchdogMain = file('../packages/watchdog/src/main.ts');
const operatorMain = file('../packages/launcher/src/operator.ts');
const liveExample = file('../config/live.example.json');
const SOUND_DB = -40;
const ANNOUNCE_EVERY_MS = 8000;
const DELAY_MS = 3000;
/** 会话断开后多久重新下发 URL；放长到 20 秒，留出在页面未认证期间逐项核对的时间。 */
const RESUME_WINDOW_MS = 20_000;
const TEXT = '这是一句用来核对开播预检的测试播报。';
const REFUSED = '开播预检未通过';
const PRESENCE = '在场确认无效';
const NO_WATCHDOG = '外部看门狗未连接';

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
const round = (ms: number) => Math.round(ms * 10) / 10;
const fact = (type: string) => (line: LogLine) => line.event === 'fact' && line.type === type;
const lists = (failures: unknown, expect: string) =>
  Array.isArray(failures) && failures.some((f) => typeof f === 'string' && f.includes(expect));

function httpGet(port: number, path: string, headers: Record<string, string>): Promise<string> {
  return new Promise((done) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers, setHost: false }, (res) => {
      res.resume();
      done(String(res.statusCode ?? 0));
    });
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.on('error', (error) => done(`error:${error.message}`));
    req.end();
  });
}

/** 尝试建立 Stage 会话：返回 HTTP 拒绝码、关闭码或 welcome（成功时立即关闭，不占会话位）。 */
function wsAttempt(
  port: number,
  headers: Record<string, string>,
  first: Record<string, unknown> | undefined,
): Promise<string> {
  return new Promise((done) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/stage`, { headers });
    let settled = false;
    const finish = (result: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(result);
      ws.terminate();
    };
    const timer = setTimeout(() => finish('timeout'), 5000);
    ws.on('unexpected-response', (req, res) => {
      finish(`http-${res.statusCode}`);
      req.destroy();
    });
    ws.on('error', (error) => finish(`error:${error.message}`));
    ws.on('open', () => {
      if (first) ws.send(JSON.stringify(first));
    });
    ws.on('message', (data) => {
      if ((JSON.parse(String(data)) as { kind?: string }).kind === 'welcome') finish('welcome');
    });
    ws.on('close', (code) => finish(`close-${code}`));
  });
}

/** profile 变体；watchdog-gone 与主 profile 相同，只是启动器不重启看门狗。 */
type Variant = 'main' | 'no-review' | 'avatar' | 'moderation-implicit' | 'watchdog-gone';

function profileFor(variant: Variant) {
  const announcements = Array.from({ length: 80 }, (_, i) => ({
    id: `a${i}`,
    atMs: 4000 + i * ANNOUNCE_EVERY_MS,
    text: TEXT,
  }));
  let entries: Array<Record<string, unknown>> = [
    { id: 'obs', plugin: 'obs-control', grant: ['obs.control'] },
    {
      id: 'stage-page',
      plugin: 'stage-page-obs',
      grant: ['obs.stage-url'],
      config: { resumeWindowMs: RESUME_WINDOW_MS },
    },
    { id: 'stage', plugin: 'stage-service' },
    {
      id: 'tts',
      plugin: 'tts-sim',
      config: { sampleRate: 24_000, samplesPerChar: 3600, frameSamples: 480, toneHz: 440 },
    },
    { id: 'speech', plugin: 'speech-arbiter', grant: ['speech.output'] },
    { id: 'review', plugin: 'speech-review', config: { delayMs: DELAY_MS } },
    { id: 'schedule', plugin: 'speech-schedule', config: { announcements, ttlMs: 20_000 } },
    { id: 'moderation', plugin: 'moderation', disabled: true },
  ];
  if (variant === 'no-review') entries = entries.filter((e) => e.id !== 'review');
  if (variant === 'avatar')
    entries.push({ id: 'avatar', plugin: 'avatar-vts', grant: ['secret:vts'] });
  if (variant === 'moderation-implicit')
    entries = entries.map((e) =>
      e.id === 'moderation' ? { id: 'moderation', plugin: 'moderation' } : e,
    );
  return { name: `drill-preflight-${variant}`, packs: [{ name: 'all', entries }] };
}

interface Timed<T> {
  value: T;
  ms: number;
}

async function timed<T>(fn: () => Promise<T>): Promise<Timed<T>> {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: round(performance.now() - t0) };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'stage-source': { type: 'string' },
      'safe-scene': { type: 'string', default: 'Safe' },
      out: { type: 'string' },
      only: { type: 'string' },
    },
  });
  const stageSource = values['stage-source'];
  if (!stageSource) throw new Error('需要 --stage-source');
  const safeScene = values['safe-scene'];
  const ONLY_KEYS = [
    'presence',
    'reroute',
    'shutdown',
    'restart',
    'safe-scene',
    'stage-source',
    'safe-item',
    'stage-unauth',
    'watchdog',
    'rejections',
    'playback',
    'no-review',
    'avatar',
    'moderation',
  ];
  const only = values.only ? new Set(values.only.split(',').map((key) => key.trim())) : undefined;
  for (const key of only ?? []) {
    if (!ONLY_KEYS.includes(key))
      throw new Error(`--only 不认识 ${key}，可选：${ONLY_KEYS.join(',')}`);
  }
  /** 只跑 --only 列出的项（不给时全跑）。 */
  const want = (key: string) => only === undefined || only.has(key);
  const started = new Date().toISOString();
  const say = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

  await waitForNoOtherBellis({ log: say });
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
  const loudBetween = (from: number, to: number) => loud.filter((t) => t >= from && t < to).length;
  const service = `bellis-drill-${randomBytes(4).toString('hex')}`;
  const store = new KeyringSecretStore(service);
  const configPath = join(tmpdir(), `${service}.json`);
  const profilePath = join(tmpdir(), `${service}.profile.json`);
  const variants: Variant[] = [
    'main',
    'no-review',
    'avatar',
    'moderation-implicit',
    'watchdog-gone',
  ];
  const storePath = (variant: Variant) => join(tmpdir(), `${service}-${variant}.db`);
  /** 临时改名用的名字。 */
  const tempScene = `${safeScene}-drill-${randomBytes(2).toString('hex')}`;
  const tempInput = `${stageSource}-drill-${randomBytes(2).toString('hex')}`;
  let original: ObsSnapshot | undefined;
  /** 正在运行的会话；在闭包里赋值，所以用断言避免被收窄成 undefined。 */
  let current = undefined as { stop(): Promise<void> } | undefined;
  const result: Record<string, unknown> = {};

  const setStage = async (settings: Record<string, unknown>) => {
    ok(
      await obs.request('SetInputSettings', {
        inputName: stageSource,
        inputSettings: settings,
        overlay: true,
      }),
    );
  };
  /** 会话结束（宿主停止时走急停路径）或急停之后，把节目场景与静音改回开始时的样子。 */
  const restoreSceneAndMute = async () => {
    if (!original) return;
    ok(await obs.request('SetCurrentProgramScene', { sceneName: original.programScene }));
    ok(
      await obs.request('SetInputMute', {
        inputName: stageSource,
        inputMuted: original.stageMuted ?? false,
      }),
    );
  };

  const writeSessionFiles = (variant: Variant) => {
    writeFileSync(profilePath, JSON.stringify(profileFor(variant)));
    const config = JSON.parse(JSON.stringify(loadConfig(liveExample)));
    config.profile = profilePath;
    config.safety.emergency = { stageSource, safeScene, stopStream: false };
    config.storePath = storePath(variant);
    writeFileSync(configPath, JSON.stringify(config));
  };

  /** 拉起一次真实会话，返回操作员调用与核对用的工具。 */
  const startLive = async (variant: Variant) => {
    await waitForNoOtherBellis({ log: say });
    writeSessionFiles(variant);
    const launcherLog: Array<Record<string, unknown>> = [];
    const session: Session = await launch({
      configPath,
      secretService: service,
      host: { command: process.execPath, args: [hostMain] },
      watchdog: { command: process.execPath, args: [watchdogMain] },
      stdout: 'pipe',
      log: (event, fields) => launcherLog.push({ t: new Date().toISOString(), event, ...fields }),
      ...(variant === 'watchdog-gone' ? { maxWatchdogRestarts: 0 } : {}),
    });
    const host = new Lines(session.host.stdout);
    const watchdogs = [new Lines(session.watchdog.stdout)];
    const key = decodeSessionKey(session.info.channelKey);
    const operator = new RpcPeer(await connect(session.info.channelPath, Role.Operator, { key }), {
      timeoutMs: 10_000,
    });
    // 启动器角色的连接只用来查询宿主是否连着看门狗（host.status），不发停止请求。
    const observer = new RpcPeer(await connect(session.info.channelPath, Role.Launcher, { key }), {
      timeoutMs: 5000,
    });
    const call = (method: string, params: Record<string, unknown> = {}) =>
      operator.request(method, params) as Promise<Record<string, unknown>>;
    const preflight = (target: string) =>
      timed(
        async () => ((await call(OperatorMethod.Preflight, { target })).failures as string[]) ?? [],
      );
    const violations: Array<Record<string, unknown>> = [];
    /** 预期被拒的切换；万一切换成功，立即急停并记下违反。 */
    const mode = async (target: string) => {
      const answer = await timed(() => call(OperatorMethod.Mode, { target }));
      if (answer.value.ok === true) {
        violations.push({ target, answer: answer.value });
        await call(OperatorMethod.EmergencyStop, { reason: '演练：预检未挡住切换' });
        await restoreSceneAndMute();
      }
      return answer;
    };
    const cli = (args: string[]) =>
      new Promise<{ output: unknown; code: number | null; ms: number }>((done) => {
        const t0 = performance.now();
        const child = spawn(process.execPath, [operatorMain, ...args], {
          env: { ...process.env, [ChildEnv.SecretService]: service },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
          stdout += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.on('close', (code) => {
          let output: unknown;
          try {
            output = JSON.parse(stdout);
          } catch {
            output = (stdout + stderr).trim();
          }
          done({ output, code, ms: round(performance.now() - t0) });
        });
      });
    const watchdogConnected = async () =>
      ((await observer.request(HostStatus)) as { watchdogConnected: boolean }).watchdogConnected;
    /** 等到 M1 与 M2 的预检都通过。 */
    const untilPass = async (timeoutMs: number) => {
      const t0 = performance.now();
      let last: Record<string, string[]> = {};
      for (;;) {
        last = {
          M1: (await preflight('M1')).value,
          M2: (await preflight('M2')).value,
        };
        if (last.M1?.length === 0 && last.M2?.length === 0)
          return { passed: true, ms: round(performance.now() - t0) };
        if (performance.now() - t0 > timeoutMs)
          return { passed: false, ms: round(performance.now() - t0), failures: last };
        await sleep(250);
      }
    };
    const live = {
      variant,
      session,
      host,
      watchdogs,
      launcherLog,
      violations,
      call,
      preflight,
      mode,
      cli,
      watchdogConnected,
      untilPass,
      async stop() {
        operator.connection.close();
        observer.connection.close();
        await session.stop();
        await restoreSceneAndMute();
      },
    };
    current = live;
    return live;
  };
  type Live = Awaited<ReturnType<typeof startLive>>;

  interface Item {
    name: string;
    /** 预检应当列出的失败项（子串）。 */
    expect: string;
    /** 预检应当列出它的目标模式。 */
    targets?: string[];
    inject?: () => Promise<void>;
    /** 恢复；没有时（profile 变体）不做恢复核对。 */
    restore?: () => Promise<void>;
    /** 恢复后从 OBS 读回，返回与原值不一致之处。 */
    verify?: () => Promise<string[]>;
    restoreTimeoutMs?: number;
  }

  /** 制造一个失败，核对预检列出它、切换被拒，恢复后预检重新通过。 */
  const runItem = async (live: Live, item: Item) => {
    const targets = item.targets ?? ['M1', 'M2'];
    const record: Record<string, unknown> = { name: item.name, expect: item.expect, targets };
    say(`开始：${item.name}`);
    const t0 = performance.now();
    let injected = false;
    try {
      await item.inject?.();
      injected = true;
      // 等预检列出这一项，再等到只剩这一项：改浏览器源的设置会让 OBS 重建浏览器，页面重新认证之前
      // 还会列出“Stage 页面尚未认证”。
      const observed: Array<{ atMs: number; failures: string[] }> = [];
      let listedAfterMs: number | undefined;
      let alone = false;
      const target = targets[0] ?? 'M1';
      for (const deadline = performance.now() + 20_000; ; ) {
        const failures = (await live.preflight(target)).value;
        const atMs = round(performance.now() - t0);
        if (!isDeepStrictEqual(observed.at(-1)?.failures, failures))
          observed.push({ atMs, failures });
        if (lists(failures, item.expect)) {
          listedAfterMs ??= atMs;
          if (failures.every((f) => f.includes(item.expect))) {
            alone = true;
            break;
          }
        }
        if (performance.now() > deadline) break;
        await sleep(250);
      }
      record.listedAfterMs = listedAfterMs ?? null;
      record.alone = alone;
      record.observed = observed;
      const preflight: Record<string, Timed<string[]>> = {};
      const cli: Record<string, unknown> = {};
      const mode: Record<string, Timed<Record<string, unknown>>> = {};
      for (const t of ['M1', 'M2']) preflight[t] = await live.preflight(t);
      for (const t of ['M1', 'M2']) cli[t] = await live.cli(['preflight', t]);
      // 先确认在场：M2 的拒绝只能来自预检。
      await live.call(OperatorMethod.Presence);
      for (const t of targets) mode[t] = await live.mode(t);
      record.preflight = preflight;
      record.cli = cli;
      record.mode = mode;
      const checks = targets.flatMap((t) => [
        lists(preflight[t]?.value, item.expect),
        lists((cli[t] as { output: { failures?: unknown } }).output?.failures, item.expect),
        mode[t]?.value.ok === false &&
          mode[t]?.value.reason === REFUSED &&
          lists(mode[t]?.value.failures, item.expect),
      ]);
      record.listedAndRefused = checks.every(Boolean);
    } catch (error) {
      record.error = (error as Error).message;
    } finally {
      if (injected && item.restore) {
        try {
          await item.restore();
        } catch (error) {
          record.restoreError = (error as Error).message;
        }
      }
    }
    if (item.restore) {
      const again = await live.untilPass(item.restoreTimeoutMs ?? 30_000);
      const diffs = item.verify ? await item.verify() : [];
      record.restore = { ...again, obsDiffs: diffs };
      record.pass =
        record.listedAndRefused === true && again.passed && diffs.length === 0 && !record.error;
    } else {
      record.restore = 'profile 变体：恢复即换回主 profile（见 baseline）';
      record.pass = record.listedAndRefused === true && !record.error;
    }
    say(`${record.pass ? '通过' : '未通过'}：${item.name}`);
    return record;
  };

  const stageSettings = async () =>
    ok(await obs.request('GetInputSettings', { inputName: stageSource })).inputSettings as Record<
      string,
      unknown
    >;
  const settingItem = (key: string, value: boolean, expect: string): Item => ({
    name: `浏览器源 ${key}=${value}`,
    expect,
    inject: () => setStage({ [key]: value }),
    restore: () => setStage({ [key]: original?.stageSettings[key] ?? !value }),
    verify: async () => {
      const now = (await stageSettings())[key];
      return now === original?.stageSettings[key] ? [] : [`${key} 读回为 ${JSON.stringify(now)}`];
    },
  });

  try {
    if (ok(await obs.request('GetStreamStatus')).outputActive)
      throw new Error('推流进行中，拒绝运行');
    if (ok(await obs.request('GetRecordStatus')).outputActive)
      throw new Error('录制进行中，拒绝运行');
    result.obsVersion = ok(await obs.request('GetVersion')).obsVersion;
    original = await snapshot(obs, stageSource, safeScene);
    if (original.programScene === safeScene) throw new Error('节目场景已经是安全场景');
    if (!original.inputs.includes(stageSource)) throw new Error(`没有输入「${stageSource}」`);
    if (!original.scenes.includes(safeScene)) throw new Error(`没有场景「${safeScene}」`);
    if (original.safeItems.some((i) => i.sourceName === stageSource))
      throw new Error('安全场景里已经含有 Stage 源');
    const snap = original;
    ok(await obs.request('SetInputMute', { inputName: stageSource, inputMuted: false }));
    await writeObsSecret(store, secret, OBS_SECRET);

    // ---------------- 主 profile ----------------
    const live = await startLive('main');
    const items: Array<Record<string, unknown>> = [];
    try {
      await live.host.wait((l) => l.event === 'stage-page.authenticated', 30_000);
      const port = live.host.items.find((l) => l.event === 'stage-page.listening')?.port as number;
      const pageOrigin = `http://127.0.0.1:${port}`;
      // 基线：会话开始时还没有确认在场，M1 的预检应全部通过、M2 只列出在场确认。
      const baseline: Record<string, unknown> = { passed: false };
      for (const t0 = performance.now(); performance.now() - t0 < 30_000; ) {
        const m1 = (await live.preflight('M1')).value;
        const m2 = (await live.preflight('M2')).value;
        Object.assign(baseline, { ms: round(performance.now() - t0), M1: m1, M2: m2 });
        if (m1.length === 0 && isDeepStrictEqual(m2, [PRESENCE])) {
          baseline.passed = true;
          break;
        }
        await sleep(250);
      }
      result.baseline = baseline;
      say(`基线预检：${JSON.stringify(baseline)}`);
      if (!baseline.passed) throw new Error('基线预检未通过，不再逐项演练');

      // M2 未确认在场：会话开始时还没有确认过。
      if (want('presence')) {
        const before = (await live.call(OperatorMethod.Status)).presenceValid;
        const preflightM1 = await live.preflight('M1');
        const preflightM2 = await live.preflight('M2');
        const cliM1 = await live.cli(['preflight', 'M1']);
        const cliM2 = await live.cli(['preflight', 'M2']);
        const m2 = await live.mode('M2');
        await live.call(OperatorMethod.Presence);
        const after = (await live.call(OperatorMethod.Status)).presenceValid;
        const again = await live.untilPass(5000);
        const record = {
          name: 'M2 未确认在场（安全核的前置条件）',
          presenceValidBefore: before,
          preflightM1,
          preflightM2,
          cliM1,
          cliM2,
          modeM2: m2,
          presenceValidAfter: after,
          afterPresence: again,
          note: 'M1 不要求在场：M1 的预检不列出这一项，所以不切 M1。',
          pass:
            before === false &&
            preflightM1.value.length === 0 &&
            lists(preflightM2.value, PRESENCE) &&
            (cliM1.output as { failures?: unknown[] }).failures?.length === 0 &&
            lists((cliM2.output as { failures?: unknown }).failures, PRESENCE) &&
            m2.value.ok === false &&
            m2.value.reason === PRESENCE &&
            after === true &&
            again.passed,
        };
        items.push(record);
        say(`${record.pass ? '通过' : '未通过'}：${record.name}`);
      } else {
        await live.call(OperatorMethod.Presence);
      }

      if (want('reroute'))
        items.push(
          await runItem(
            live,
            settingItem('reroute_audio', false, '没有开启“Control audio via OBS”'),
          ),
        );
      if (want('shutdown'))
        items.push(
          await runItem(
            live,
            settingItem('shutdown', true, '开启了“Shutdown source when not visible”'),
          ),
        );
      if (want('restart'))
        items.push(
          await runItem(
            live,
            settingItem(
              'restart_when_active',
              true,
              '开启了“Refresh browser when scene becomes active”',
            ),
          ),
        );
      if (want('safe-scene'))
        items.push(
          await runItem(live, {
            name: '安全场景不存在（临时改名）',
            expect: `OBS 中没有安全场景「${safeScene}」`,
            inject: async () => {
              ok(
                await obs.request('SetSceneName', {
                  sceneName: safeScene,
                  newSceneName: tempScene,
                }),
              );
            },
            restore: async () => {
              ok(
                await obs.request('SetSceneName', {
                  sceneName: tempScene,
                  newSceneName: safeScene,
                }),
              );
            },
            verify: async () => {
              const now = await snapshot(obs, stageSource, safeScene);
              return isDeepStrictEqual(now.scenes, snap.scenes)
                ? []
                : [`场景读回为 ${JSON.stringify(now.scenes)}`];
            },
          }),
        );
      if (want('stage-source'))
        items.push(
          await runItem(live, {
            name: 'Stage 静音目标不存在（临时改名）',
            expect: `OBS 中没有 Stage 源「${stageSource}」`,
            inject: async () => {
              ok(
                await obs.request('SetInputName', {
                  inputName: stageSource,
                  newInputName: tempInput,
                }),
              );
            },
            restore: async () => {
              ok(
                await obs.request('SetInputName', {
                  inputName: tempInput,
                  newInputName: stageSource,
                }),
              );
            },
            verify: async () => {
              const now = await snapshot(obs, stageSource, safeScene);
              return isDeepStrictEqual(now.inputs, snap.inputs)
                ? []
                : [`输入读回为 ${JSON.stringify(now.inputs)}`];
            },
          }),
        );
      let addedItem: number | undefined;
      if (want('safe-item'))
        items.push(
          await runItem(live, {
            name: '安全场景里含 Stage 源（临时加一个场景项）',
            expect: `安全场景「${safeScene}」里含有 Stage 源「${stageSource}」`,
            inject: async () => {
              addedItem = ok(
                await obs.request('CreateSceneItem', {
                  sceneName: safeScene,
                  sourceName: stageSource,
                  sceneItemEnabled: true,
                }),
              ).sceneItemId as number;
            },
            restore: async () => {
              if (addedItem === undefined) return;
              ok(
                await obs.request('RemoveSceneItem', {
                  sceneName: safeScene,
                  sceneItemId: addedItem,
                }),
              );
            },
            verify: async () => {
              const now = await snapshot(obs, stageSource, safeScene);
              return isDeepStrictEqual(now.safeItems, snap.safeItems)
                ? []
                : [`安全场景的场景项读回为 ${JSON.stringify(now.safeItems)}`];
            },
          }),
        );
      if (want('stage-unauth')) {
        const from = live.host.items.length;
        const record = await runItem(live, {
          name: 'Stage 页面未认证（URL 改成 about:blank，页面卸载）',
          expect: 'Stage 页面尚未认证',
          inject: () => setStage({ url: 'about:blank' }),
          // 不由演练写回：宿主在重连时限过后自己重新下发带新令牌的 URL。
          restore: async () => {},
          restoreTimeoutMs: RESUME_WINDOW_MS + 30_000,
          verify: async () => {
            const url = String((await stageSettings()).url ?? '');
            return url.startsWith(`${pageOrigin}/#t=`) ? [] : ['URL 没有被宿主重新下发'];
          },
        });
        const after = live.host.items.slice(from);
        const at = (event: string) => after.find((l) => l.event === event)?.t;
        record.hostTimeline = {
          disconnected: at('stage-page.disconnected') ?? null,
          redistributed: after.find((l) => l.event === 'stage-page.distributed')?.reason ?? null,
          redistributedAt: at('stage-page.distributed') ?? null,
          authenticated: at('stage-page.authenticated') ?? null,
        };
        items.push(record);
      }

      // 看门狗未连接：终止看门狗进程；启动器约 0.5 秒后重启它，所以先用 RPC 跑预检、再切换。
      if (want('watchdog')) {
        const old = live.session.watchdog;
        const t0 = performance.now();
        process.kill(old.pid);
        await old.exited;
        const exitedMs = round(performance.now() - t0);
        let seenMs: number | undefined;
        for (const deadline = performance.now() + 2000; performance.now() < deadline; ) {
          if (!(await live.watchdogConnected())) {
            seenMs = round(performance.now() - t0);
            break;
          }
          await sleep(5);
        }
        const record: Record<string, unknown> = {
          name: '看门狗未连接（安全核的前置条件；启动器随后重启看门狗）',
          exitedMs,
          hostSawDisconnectMs: seenMs ?? null,
        };
        if (seenMs !== undefined) {
          record.preflightM1 = await live.preflight('M1');
          record.preflightM2 = await live.preflight('M2');
          record.modeM1 = await live.mode('M1');
          record.modeM2 = await live.mode('M2');
          // 核对完时宿主仍未重新连上看门狗，上面的结果才都发生在断开期间。
          record.stillDisconnected = !(await live.watchdogConnected());
        }
        let reconnectedMs: number | undefined;
        for (const deadline = performance.now() + 15_000; performance.now() < deadline; ) {
          if (await live.watchdogConnected()) {
            reconnectedMs = round(performance.now() - t0);
            break;
          }
          await sleep(50);
        }
        if (live.session.watchdog !== old)
          live.watchdogs.push(new Lines(live.session.watchdog.stdout));
        record.reconnectedMs = reconnectedMs ?? null;
        record.afterReconnect = await live.untilPass(10_000);
        record.launcher = live.launcherLog.slice();
        const refused = (answer: unknown) =>
          (answer as Timed<Record<string, unknown>> | undefined)?.value.ok === false &&
          (answer as Timed<Record<string, unknown>>).value.reason === NO_WATCHDOG;
        const listed = (answer: unknown) =>
          lists((answer as Timed<string[]> | undefined)?.value, NO_WATCHDOG);
        record.pass =
          seenMs !== undefined &&
          record.stillDisconnected === true &&
          listed(record.preflightM1) &&
          listed(record.preflightM2) &&
          refused(record.modeM1) &&
          refused(record.modeM2) &&
          reconnectedMs !== undefined &&
          (record.afterReconnect as { passed: boolean }).passed;
        items.push(record);
        say(`${record.pass ? '通过' : '未通过'}：${record.name}`);
      }
      result.items = items;
      result.afterItems = await live.untilPass(30_000);

      // ---------------- 真实会话中的 Stage 拒绝核对 ----------------
      if (want('rejections')) {
        say('开始：Stage 拒绝核对');
        const host = `127.0.0.1:${port}`;
        const origin = pageOrigin;
        const navigate = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
        const from = live.host.items.length;
        const authenticatedBefore = live.host.items.filter(
          (l) => l.event === 'stage-page.authenticated',
        ).length;
        const url = String((await stageSettings()).url ?? '');
        const usedToken = new URLSearchParams(url.split('#')[1] ?? '').get('t');
        const fakeToken = randomBytes(16).toString('base64url');
        const hello = (token: string | null) => ({
          kind: 'hello',
          token,
          obs: null,
          userAgent: 'drill-preflight',
          sampleRate: 48_000,
        });
        const cases: Array<[name: string, expected: string, run: () => Promise<string>]> = [
          [
            '对照：顶层文档导航（不带 Origin）',
            '200',
            () => httpGet(port, '/', { host, ...navigate }),
          ],
          ['对照：子资源带正确的 Origin', '200', () => httpGet(port, '/page.js', { host, origin })],
          [
            'Host 为 localhost（顶层导航）',
            '403',
            () => httpGet(port, '/', { host: `localhost:${port}`, ...navigate }),
          ],
          [
            'DNS 重绑定的 Host',
            '403',
            () => httpGet(port, '/', { host: `evil.example:${port}`, ...navigate }),
          ],
          ['Host 不带端口', '403', () => httpGet(port, '/', { host: '127.0.0.1', ...navigate })],
          [
            '升级的 Host 错误',
            'http-403',
            () => wsAttempt(port, { host: `evil.example:${port}`, origin }, hello(fakeToken)),
          ],
          [
            '子资源的 Origin 错误',
            '403',
            () => httpGet(port, '/page.js', { host, origin: 'http://evil.example' }),
          ],
          [
            '子资源的 Origin 为 localhost',
            '403',
            () => httpGet(port, '/page.js', { host, origin: `http://localhost:${port}` }),
          ],
          [
            '升级的 Origin 错误',
            'http-403',
            () => wsAttempt(port, { origin: 'http://evil.example' }, hello(fakeToken)),
          ],
          [
            '升级的 Origin 为 null',
            'http-403',
            () => wsAttempt(port, { origin: 'null' }, hello(fakeToken)),
          ],
          ['脚本不带 Origin', '403', () => httpGet(port, '/page.js', { host })],
          [
            'AudioWorklet 模块不带 Origin',
            '403',
            () =>
              httpGet(port, '/worklet.js', {
                host,
                'sec-fetch-mode': 'no-cors',
                'sec-fetch-dest': 'audioworklet',
              }),
          ],
          [
            '样式表不带 Origin（no-cors）',
            '403',
            () =>
              httpGet(port, '/stage.css', {
                host,
                'sec-fetch-mode': 'no-cors',
                'sec-fetch-dest': 'style',
              }),
          ],
          [
            '页面被嵌进 iframe（不带 Origin）',
            '403',
            () =>
              httpGet(port, '/', {
                host,
                'sec-fetch-mode': 'navigate',
                'sec-fetch-dest': 'iframe',
              }),
          ],
          ['页面文档不带 Sec-Fetch 头', '403', () => httpGet(port, '/', { host })],
          ['升级不带 Origin', 'http-403', () => wsAttempt(port, {}, hello(fakeToken))],
          [
            '第二个会话（Host 与 Origin 都正确）',
            'http-409',
            () => wsAttempt(port, { origin }, hello(fakeToken)),
          ],
          [
            '会话进行中重放用过的令牌',
            'http-409',
            () => wsAttempt(port, { origin }, hello(usedToken)),
          ],
        ];
        const checks: Array<Record<string, unknown>> = [];
        for (const [name, expected, run] of cases) {
          const actual = await run();
          checks.push({ name, expected, actual, pass: actual === expected });
        }
        await sleep(500);
        const during = live.host.items.slice(from);
        const sessionUnaffected = {
          refusedLogged: during
            .filter((l) => l.event === 'stage-page.refused')
            .map((l) => ({ kind: l.kind, path: l.path, reason: l.reason })),
          disconnects: during.filter((l) =>
            ['stage-page.disconnected', 'stage-page.idle', 'stage-page.rejected'].includes(l.event),
          ).length,
          newAuthentications:
            live.host.items.filter((l) => l.event === 'stage-page.authenticated').length -
            authenticatedBefore,
          preflight: await live.untilPass(5000),
        };

        // 没有会话时重放用过的令牌：URL 改成 about:blank，等会话断开。
        const replayFrom = live.host.items.length;
        await setStage({ url: 'about:blank' });
        await live.host.wait((l) => l.event === 'stage-page.disconnected', 10_000, replayFrom);
        const wrongResume = await wsAttempt(
          port,
          { origin },
          { kind: 'resume', sessionKey: randomBytes(32).toString('base64url') },
        );
        const t0 = performance.now();
        const replay = await wsAttempt(port, { origin }, hello(usedToken));
        const reauthenticated = await live.host
          .wait((l) => l.event === 'stage-page.authenticated', 30_000, replayFrom)
          .then(() => round(performance.now() - t0))
          .catch(() => null);
        const afterReplay = live.host.items.slice(replayFrom);
        const noSession = {
          wrongSessionKey: { expected: 'close-4401', actual: wrongResume },
          replayedToken: { expected: 'close-4401', actual: replay },
          rejectedLogged: afterReplay
            .filter((l) => l.event === 'stage-page.rejected')
            .map((l) => l.reason),
          redistributed: afterReplay
            .filter((l) => l.event === 'stage-page.distributed')
            .map((l) => l.reason),
          reauthenticatedAfterReplayMs: reauthenticated,
          preflight: await live.untilPass(30_000),
        };
        result.stageRejections = {
          port,
          checks,
          sessionUnaffected,
          noSession,
          pass:
            checks.every((c) => c.pass) &&
            sessionUnaffected.disconnects === 0 &&
            sessionUnaffected.newAuthentications === 0 &&
            sessionUnaffected.preflight.passed &&
            wrongResume === 'close-4401' &&
            replay === 'close-4401' &&
            noSession.rejectedLogged.includes('session-key') &&
            noSession.rejectedLogged.includes('token') &&
            reauthenticated !== null &&
            noSession.preflight.passed,
        };
        say(`Stage 拒绝核对：${JSON.stringify(result.stageRejections)}`);
      }

      // ---------------- 之后照常播出（M2） ----------------
      if (want('playback')) {
        await live.call(OperatorMethod.Presence);
        const modeAt = Date.now();
        const m2 = await live.call(OperatorMethod.Mode, { target: 'M2' });
        if (m2.ok !== true) throw new Error(`进入 M2 失败：${JSON.stringify(m2)}`);
        const from = live.host.items.length;
        const played = await live.host.wait(
          (l) => fact('utterance.played')(l) && (l.data as { end?: string }).end === 'complete',
          ANNOUNCE_EVERY_MS + 15_000,
          from,
        );
        const playedAt = Date.parse(played.t);
        const sentence = live.host.items
          .slice(from)
          .find((l) => l.event === 'stage.sentence' && l.complete === true);
        await live.call(OperatorMethod.EmergencyStop, { reason: '演练：播出核对结束' });
        await restoreSceneAndMute();
        result.playbackAfter = {
          utterance: played.data,
          stageSentence: sentence ?? null,
          loudReadings: loudBetween(modeAt, playedAt),
          pass: loudBetween(modeAt, playedAt) > 0,
        };
        say(`之后照常播出：${JSON.stringify(result.playbackAfter)}`);
      }
      result.mainViolations = live.violations;
      result.mainLauncherLog = live.launcherLog;
    } finally {
      await live.stop();
      current = undefined;
    }

    // ---------------- 看门狗断开后不重启：从容地用 RPC 与命令行核对 ----------------
    if (want('watchdog')) {
      const variant = await startLive('watchdog-gone');
      try {
        await variant.host.wait((l) => l.event === 'stage-page.authenticated', 30_000);
        await variant.call(OperatorMethod.Presence);
        const before = await variant.untilPass(30_000);
        const old = variant.session.watchdog;
        const t0 = performance.now();
        process.kill(old.pid);
        await old.exited;
        let seenMs: number | undefined;
        for (const deadline = performance.now() + 2000; performance.now() < deadline; ) {
          if (!(await variant.watchdogConnected())) {
            seenMs = round(performance.now() - t0);
            break;
          }
          await sleep(5);
        }
        const record: Record<string, unknown> = {
          name: '看门狗未连接（安全核的前置条件；启动器不重启看门狗）',
          before,
          hostSawDisconnectMs: seenMs ?? null,
        };
        const checks: boolean[] = [seenMs !== undefined, before.passed];
        if (seenMs !== undefined) {
          const preflight: Record<string, Timed<string[]>> = {};
          const cli: Record<string, { output: unknown; ms: number }> = {};
          const mode: Record<string, Timed<Record<string, unknown>>> = {};
          for (const t of ['M1', 'M2']) preflight[t] = await variant.preflight(t);
          for (const t of ['M1', 'M2']) cli[t] = await variant.cli(['preflight', t]);
          for (const t of ['M1', 'M2']) mode[t] = await variant.mode(t);
          Object.assign(record, { preflight, cli, mode });
          for (const t of ['M1', 'M2']) {
            checks.push(
              lists(preflight[t]?.value, NO_WATCHDOG),
              // 安全核的原因列在第一项。
              preflight[t]?.value[0] === NO_WATCHDOG,
              lists((cli[t]?.output as { failures?: unknown } | undefined)?.failures, NO_WATCHDOG),
              mode[t]?.value.ok === false && mode[t]?.value.reason === NO_WATCHDOG,
            );
          }
          record.stillDisconnected = !(await variant.watchdogConnected());
          checks.push(record.stillDisconnected === true);
        }
        record.launcher = variant.launcherLog.slice();
        record.violations = variant.violations;
        record.pass = checks.every(Boolean);
        result.watchdogGone = record;
        say(`${record.pass ? '通过' : '未通过'}：${record.name}`);
      } finally {
        await variant.stop();
        current = undefined;
      }
    }

    // ---------------- profile 变体：M1 没有放行环节 ----------------
    if (want('no-review')) {
      const variant = await startLive('no-review');
      try {
        await variant.host.wait((l) => l.event === 'stage-page.authenticated', 30_000);
        const record = await runItem(variant, {
          name: 'M1 没有放行环节（profile 变体）',
          expect: 'M1 需要逐句放行环节（speech-review）',
          targets: ['M1'],
        });
        record.preflightM2 = await variant.preflight('M2');
        record.note = 'M2 不要求放行环节：M2 的预检不列出这一项，所以不切 M2。';
        record.pass =
          record.pass === true && (record.preflightM2 as Timed<string[]>).value.length === 0;
        record.violations = variant.violations;
        result.noReview = record;
      } finally {
        await variant.stop();
        current = undefined;
      }
    }

    // ---------------- profile 变体：启用了 VTube Studio 形象，但 VTS 不在 ----------------
    if (want('avatar')) {
      const variant = await startLive('avatar');
      const startedAt = Date.now();
      try {
        await variant.host.wait((l) => l.event === 'stage-page.authenticated', 30_000);
        const record = await runItem(variant, {
          name: 'profile 启用了形象插件但形象未就绪（本机没有 VTube Studio）',
          expect: '形象未就绪',
        });
        // 观察满 45 秒，核对重连不刷屏：VTS 不在时每次重连都失败，原因不变只记一次。
        await sleep(Math.max(0, 45_000 - (Date.now() - startedAt)));
        const lines = variant.host.items;
        const byEvent: Record<string, number> = {};
        for (const line of lines) byEvent[line.event] = (byEvent[line.event] ?? 0) + 1;
        const avatarLines = lines.filter((l) => l.event.startsWith('avatar.'));
        const status = await variant.call(OperatorMethod.Status);
        record.reconnect = {
          observedSeconds: Math.round((Date.now() - startedAt) / 1000),
          avatarLines: avatarLines.map((l) => ({ t: l.t, event: l.event, error: l.error ?? null })),
          hostLinesByEvent: byEvent,
          pluginState: (status.plugins as Array<{ id: string; state: string }>).find(
            (p) => p.id === 'avatar',
          ),
        };
        record.pass = record.pass === true && avatarLines.length <= 1;
        record.violations = variant.violations;
        result.avatar = record;
      } finally {
        await variant.stop();
        current = undefined;
      }
    }

    // ---------------- profile 变体：审核开关没有显式设置 ----------------
    if (want('moderation')) {
      say('开始：审核开关没有显式设置（profile 变体）');
      await waitForNoOtherBellis({ log: say });
      writeSessionFiles('moderation-implicit');
      let launchOutcome: string;
      try {
        const session = await launch({
          configPath,
          secretService: service,
          host: { command: process.execPath, args: [hostMain] },
          watchdog: { command: process.execPath, args: [watchdogMain] },
          // 子进程的输出不读：宿主在就绪前退出，看门狗随即被停止，输出很少。
          stdout: 'pipe',
        });
        await session.stop();
        await restoreSceneAndMute();
        launchOutcome = '会话启动成功（不应如此）';
      } catch (error) {
        launchOutcome = (error as Error).message;
      }
      // 直接拉起宿主读它的日志：它在读取 profile 后、连接任何东西之前退出。
      const direct = await new Promise<{ code: number | null; events: LogLine[] }>((done) => {
        const child = spawn(process.execPath, [hostMain], {
          env: {
            ...process.env,
            [ChildEnv.Config]: configPath,
            [ChildEnv.SecretService]: service,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
        const lines = new Lines(child.stdout);
        child.stderr.resume();
        const timer = setTimeout(() => child.kill(), 15_000);
        child.on('exit', (code) => {
          clearTimeout(timer);
          setTimeout(() => done({ code, events: lines.items }), 100);
        });
      });
      const invalid = direct.events.find((l) => l.event === 'host.config-invalid');
      result.moderationImplicit = {
        name: '审核插件的开关没有在 profile 中显式设置（profile 变体）',
        launch: launchOutcome,
        hostExitCode: direct.code,
        hostEvent: invalid ?? null,
        note: '宿主在启动时即拒绝运行（D-18），根本到不了预检；预检中的这一项因此在宿主里不会出现。',
        pass:
          launchOutcome.includes('宿主在就绪前退出') && direct.code === 1 && invalid !== undefined,
      };
      say(`${(result.moderationImplicit as { pass: boolean }).pass ? '通过' : '未通过'}：审核开关`);
    }
    result.tts = 'PENDING：TTS 就绪一项要等 TTS 路由合入';
  } catch (error) {
    result.error = (error as Error).stack ?? String(error);
    say(`演练中止：${(error as Error).message}`);
  } finally {
    await current?.stop().catch(() => {});
    meters.close();
    if (original) {
      const steps: string[] = [];
      const attempt = async (label: string, request: () => Promise<ObsResult>) => {
        try {
          const answer = await request();
          if (!answer.ok) steps.push(`${label}失败：${answer.code} ${answer.comment ?? ''}`);
        } catch (error) {
          steps.push(`${label}出错：${(error as Error).message}`);
        }
      };
      const now = await snapshot(obs, stageSource, safeScene);
      if (!now.scenes.includes(safeScene) && now.scenes.includes(tempScene))
        await attempt('安全场景改回原名', () =>
          obs.request('SetSceneName', { sceneName: tempScene, newSceneName: safeScene }),
        );
      if (!now.inputs.includes(stageSource) && now.inputs.includes(tempInput))
        await attempt('Stage 源改回原名', () =>
          obs.request('SetInputName', { inputName: tempInput, newInputName: stageSource }),
        );
      const safe = await snapshot(obs, stageSource, safeScene);
      for (const item of safe.safeItems) {
        if (original.safeItems.some((o) => o.sceneItemId === item.sceneItemId)) continue;
        await attempt('删除安全场景里多出的场景项', () =>
          obs.request('RemoveSceneItem', { sceneName: safeScene, sceneItemId: item.sceneItemId }),
        );
      }
      // 整体写回开始时的浏览器源设置（包括 URL）、节目场景与静音。
      steps.push(...(await restoreSnapshot(obs, original, stageSource)));
      const diffs = differences(original, await snapshot(obs, stageSource, safeScene));
      result.obsRestored = { ok: steps.length === 0 && diffs.length === 0, steps, diffs };
      say(`OBS 恢复：${JSON.stringify(result.obsRestored)}`);
    }
    obs.close();
    await store.delete(OBS_SECRET);
    await store.delete(SESSION_SECRET);
    for (const path of [configPath, profilePath]) rmSync(path, { force: true });
    for (const variant of variants) {
      for (const suffix of ['', '-wal', '-shm'])
        rmSync(`${storePath(variant)}${suffix}`, { force: true });
    }
  }
  const out = resolve(
    values.out ?? join('reports', `drill-preflight-${started.slice(0, 10)}.json`),
  );
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    `${JSON.stringify({ drill: 'preflight', started, finished: new Date().toISOString(), node: process.version, stageSource, safeScene, resumeWindowMs: RESUME_WINDOW_MS, ...result }, null, 2)}\n`,
  );
  console.log(`结果已写入 ${out}`);
}

await main();
