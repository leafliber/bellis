/**
 * P1 第 4 步的真机演练：真实宿主、真实 Stage 页面（OBS 浏览器源）与 OBS（P1 任务卡出口“Stage”与“停止到静音”）。
 *
 *   node spikes/drill-stage.ts --stage-source 名字 [--safe-scene Safe] [--estops N] [--out 结果文件]
 *
 * 用启动器的 launch() 拉起真实的宿主与看门狗。profile 含 OBS 控制、真实 Stage 页面与服务、
 * 输出 440Hz 测试音的模拟 TTS、发声仲裁与每 6 秒一句的定时播报（审核显式关闭）。依次核对：
 *   1. 安全停止下宿主把带一次性令牌的 URL 写进浏览器源，OBS 加载页面后认证成功，握手记下 OBS 与内核版本。
 *   2. 切到 M1 后定时播报经真实页面完整播出（utterance.played），测试音只出现在浏览器源上。
 *   3. 停止到静音：测试音正在播放时操作员急停，到 OBS 音量表上浏览器源无声的时间（音量表约每 50ms 一次）。
 *   4. 刷新浏览器源（不用缓存）：页面重放已用过的令牌被拒，宿主限频重新下发 URL，页面重新认证；
 *      之后的播报仍只经 OBS 输出。
 *
 * 会改写浏览器源的 URL、切换节目场景并静音；推流或录制进行中时拒绝运行，结束后恢复原来的 URL、场景与静音。
 * 用临时的 SecretStore 服务名存放会话信息与 OBS 凭据副本，结束时删除。
 */
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
/** 有声与无声的音量表阈值（dBFS）；测试音约 -14dBFS。 */
const SOUND_DB = -40;
const SILENT_DB = -60;
const ANNOUNCE_EVERY_MS = 6000;
const TEXT = '这是一句用来核对真实舞台播放的测试播报内容。';

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

/** 记下每个输入最近一次的音量与它到达的时刻。 */
class Meter {
  readonly latest = new Map<string, { db: number; at: number }>();
  readonly #waiters = new Set<() => void>();

  update(readings: MeterReading[]): void {
    const at = Date.now();
    for (const reading of readings) this.latest.set(reading.name, { db: reading.peakDb, at });
    for (const wake of this.#waiters) wake();
  }

  /** 等到某个输入的音量满足条件（只看 after 之后到达的读数），返回那次读数到达的时刻。 */
  async until(
    name: string,
    match: (db: number) => boolean,
    timeoutMs: number,
    after = Number.NEGATIVE_INFINITY,
  ): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const reading = this.latest.get(name);
      if (reading && reading.at > after && match(reading.db)) return reading.at;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`音量表未在时限内满足条件：${name} ${reading?.db}`);
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
  return {
    n: sorted.length,
    min: sorted[0] ?? 0,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'stage-source': { type: 'string' },
      'safe-scene': { type: 'string', default: 'Safe' },
      estops: { type: 'string', default: '10' },
      out: { type: 'string' },
    },
  });
  const stageSource = values['stage-source'];
  if (!stageSource) throw new Error('需要 --stage-source');
  const safeScene = values['safe-scene'];
  const estops = Number(values.estops);

  const secret = await readObsSecret(new KeyringSecretStore('bellis'), OBS_SECRET);
  const obs = await ObsClient.connect(secret.url, secret.password);
  const meter = new Meter();
  const meters = await ObsMeters.connect(secret.url, secret.password, (r) => meter.update(r));
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
    const scenes = ok(await obs.request('GetSceneList'));
    original = {
      scene: scenes.currentProgramSceneName as string,
      muted: ok(await obs.request('GetInputMute', { inputName: stageSource }))
        .inputMuted as boolean,
      settings: ok(await obs.request('GetInputSettings', { inputName: stageSource }))
        .inputSettings as Record<string, unknown>,
    };
    if (original.scene === safeScene) throw new Error('节目场景已经是安全场景');
    const others = ok(await obs.request('GetInputList')).inputs as Array<{ inputName: string }>;
    const otherInputs = others.map((i) => i.inputName).filter((name) => name !== stageSource);
    ok(await obs.request('SetInputMute', { inputName: stageSource, inputMuted: false }));

    await writeObsSecret(store, secret, OBS_SECRET);
    const announcements = Array.from({ length: 60 }, (_, i) => ({
      id: `a${i}`,
      atMs: 3000 + i * ANNOUNCE_EVERY_MS,
      text: TEXT,
    }));
    writeFileSync(
      profilePath,
      JSON.stringify({
        name: 'drill-stage',
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
                  sampleRate: 24_000,
                  samplesPerChar: 3600,
                  frameSamples: 480,
                  toneHz: 440,
                },
              },
              { id: 'speech', plugin: 'speech-arbiter', grant: ['speech.output'] },
              { id: 'schedule', plugin: 'speech-schedule', config: { announcements, ttlMs: 4000 } },
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
    void new Lines(session.watchdog.stdout);
    const key = decodeSessionKey(session.info.channelKey);
    const operator = new RpcPeer(await connect(session.info.channelPath, Role.Operator, { key }), {
      timeoutMs: 5000,
    });
    const mode = async (target: string) => {
      const now = (await operator.request(OperatorMethod.Status)) as { mode: string };
      if (now.mode === target) return;
      const answer = (await operator.request(OperatorMethod.Mode, { target })) as {
        ok: boolean;
        reason?: string;
      };
      if (!answer.ok) throw new Error(`切到 ${target} 失败：${answer.reason}`);
    };

    // 1. 安全停止下下发 URL，页面认证。
    const distributed = await host.wait((l) => l.event === 'stage-page.distributed', 20_000);
    const authenticated = await host.wait((l) => l.event === 'stage-page.authenticated', 30_000);
    const connected = await host
      .wait((l) => l.event === 'fact' && l.type === 'stage.connected', 5000)
      .catch(() => undefined);
    const status = (await operator.request(OperatorMethod.Status)) as { mode: string };
    result.handshake = {
      modeWhileDistributing: status.mode,
      distributedMs: Date.parse(distributed.t) - launchedAt,
      authenticatedMs: Date.parse(authenticated.t) - launchedAt,
      versions: connected?.data ?? null,
    };
    console.log('握手：', JSON.stringify(result.handshake));

    // 2. M1 下完整播出，测试音只经浏览器源。
    await mode('M1');
    const playedFrom = host.items.length;
    await meter.until(stageSource, (db) => db > SOUND_DB, 20_000);
    let leaked = Number.NEGATIVE_INFINITY;
    const watchLeak = setInterval(() => {
      for (const name of otherInputs)
        leaked = Math.max(leaked, meter.latest.get(name)?.db ?? -Infinity);
    }, 50);
    const played = await host.wait(
      (l) => l.event === 'fact' && l.type === 'utterance.played',
      20_000,
      playedFrom,
    );
    clearInterval(watchLeak);
    result.playback = {
      utterance: played.data,
      otherInputsMaxDb: Number.isFinite(leaked) ? leaked : 'silent',
    };
    console.log('播放：', JSON.stringify(result.playback));

    // 3. 停止到静音。
    const stops: Array<Record<string, unknown>> = [];
    for (let n = 0; n < estops; n++) {
      ok(await obs.request('SetCurrentProgramScene', { sceneName: original.scene }));
      ok(await obs.request('SetInputMute', { inputName: stageSource, inputMuted: false }));
      await mode('M1');
      try {
        await meter.until(stageSource, (db) => db > SOUND_DB, ANNOUNCE_EVERY_MS + 8000);
        await sleep(700);
        // 急停前最后一次读数仍有声，才算是在播放中停止。
        if (!((meter.latest.get(stageSource)?.db ?? -Infinity) > SOUND_DB))
          throw new Error('急停前已无声');
        const t0 = Date.now();
        const estop = operator.request(OperatorMethod.EmergencyStop, {
          reason: '演练：停止到静音',
        });
        const silentAt = await meter.until(stageSource, (db) => db < SILENT_DB, 3000, t0);
        const report = (await estop) as { obs: { ok: boolean } };
        const entry = { stopToSilentMs: silentAt - t0, obsOk: report.obs.ok };
        stops.push(entry);
        console.log(`停止到静音 #${n + 1}：${JSON.stringify(entry)}`);
      } catch (error) {
        stops.push({ error: (error as Error).message });
        console.log(`停止到静音 #${n + 1}：失败 ${(error as Error).message}`);
        await operator.request(OperatorMethod.EmergencyStop, { reason: '演练：失败后收尾' });
      }
      await sleep(300);
    }
    result.stopToSilent = {
      trials: stops,
      ms: summarize(
        stops.map((s) => s.stopToSilentMs).filter((v): v is number => typeof v === 'number'),
      ),
    };

    // 4. 刷新浏览器源：刷新后页面没有令牌，报到被拒，宿主重新下发，再次认证，声音仍只经 OBS。
    ok(await obs.request('SetCurrentProgramScene', { sceneName: original.scene }));
    ok(await obs.request('SetInputMute', { inputName: stageSource, inputMuted: false }));
    const refreshFrom = host.items.length;
    const refreshedAt = Date.now();
    ok(
      await obs.request('PressInputPropertiesButton', {
        inputName: stageSource,
        propertyName: 'refreshnocache',
      }),
    );
    const rejected = await host.wait((l) => l.event === 'stage-page.rejected', 15_000, refreshFrom);
    const redistributed = await host.wait(
      (l) => l.event === 'stage-page.distributed',
      15_000,
      refreshFrom,
    );
    const reauthenticated = await host.wait(
      (l) => l.event === 'stage-page.authenticated',
      30_000,
      refreshFrom,
    );
    await mode('M1');
    const againFrom = host.items.length;
    await meter.until(stageSource, (db) => db > SOUND_DB, ANNOUNCE_EVERY_MS + 8000);
    leaked = Number.NEGATIVE_INFINITY;
    const watchLeakAgain = setInterval(() => {
      for (const name of otherInputs)
        leaked = Math.max(leaked, meter.latest.get(name)?.db ?? -Infinity);
    }, 50);
    const playedAgain = await host.wait(
      (l) => l.event === 'fact' && l.type === 'utterance.played',
      20_000,
      againFrom,
    );
    clearInterval(watchLeakAgain);
    result.refresh = {
      rejectedReason: rejected.reason,
      redistributedMs: Date.parse(redistributed.t) - refreshedAt,
      reauthenticatedMs: Date.parse(reauthenticated.t) - refreshedAt,
      utterance: playedAgain.data,
      otherInputsMaxDb: Number.isFinite(leaked) ? leaked : 'silent',
    };
    console.log('刷新：', JSON.stringify(result.refresh));
    await operator.request(OperatorMethod.EmergencyStop, { reason: '演练结束' });
    operator.connection.close();
    result.refusedOrRejected = host.items
      .filter((l) => l.event === 'stage-page.refused' || l.event === 'stage-page.rejected')
      .map((l) => ({ event: l.event, reason: l.reason, kind: l.kind, path: l.path }));
  } finally {
    await session?.stop();
    meters.close();
    if (original) {
      await obs.request('SetInputSettings', {
        inputName: stageSource,
        inputSettings: { url: original.settings.url ?? '' },
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

  const out = resolve(values.out ?? join('reports', `drill-stage-${started.slice(0, 10)}.json`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    `${JSON.stringify({ drill: 'stage', started, finished: new Date().toISOString(), node: process.version, stageSource, safeScene, ...result }, null, 2)}\n`,
  );
  console.log(JSON.stringify(result.stopToSilent && (result.stopToSilent as { ms: unknown }).ms));
  console.log(`结果已写入 ${out}`);
}

await main();
