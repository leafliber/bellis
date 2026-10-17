/**
 * P1 第 8 步的真机演练：真实输出模式与开播预检（P1 任务卡出口“OBS 与安全核”中 M1、M2 与预检的各项）。
 *
 *   node spikes/drill-output.ts --stage-source 名字 [--safe-scene Safe] [--out 结果文件]
 *
 * 用启动器拉起真实宿主与看门狗。profile 含 OBS 控制、真实 Stage、440Hz 测试音的模拟 TTS、发声仲裁、
 * M1 放行环节（延迟 3 秒）与每 8 秒一句的定时播报，审核显式关闭。依次核对：
 *   1. 开播预检全部通过；关掉浏览器源的“Control audio via OBS”后预检列出该项，进入 M1 被拒；恢复后重新通过。
 *   2. M1：播报先进入等待放行（status 的 held 可见），期满后播出，OBS 音量表上有声。
 *   3. M1：等待中被操作员否决的句子不播出（记为 speech.vetoed，音量表保持无声）。
 *   4. M2：确认在场后切到 M2，播报不经等待直接播出。
 *   5. 急停后继续到点的播报都不播出，音量表保持无声。
 *
 * 会改写浏览器源的 URL 与设置、切换节目场景并静音；推流或录制进行中时拒绝运行，结束后恢复。
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
const SOUND_DB = -40;
const ANNOUNCE_EVERY_MS = 8000;
const DELAY_MS = 3000;
const TEXT = '这是一句用来核对真实输出模式的测试播报。';

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

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'stage-source': { type: 'string' },
      'safe-scene': { type: 'string', default: 'Safe' },
      out: { type: 'string' },
    },
  });
  const stageSource = values['stage-source'];
  if (!stageSource) throw new Error('需要 --stage-source');
  const safeScene = values['safe-scene'];

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
      atMs: 4000 + i * ANNOUNCE_EVERY_MS,
      text: TEXT,
    }));
    writeFileSync(
      profilePath,
      JSON.stringify({
        name: 'drill-output',
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
              { id: 'review', plugin: 'speech-review', config: { delayMs: DELAY_MS } },
              {
                id: 'schedule',
                plugin: 'speech-schedule',
                config: { announcements, ttlMs: 20_000 },
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
      timeoutMs: 10_000,
    });
    const call = (method: string, params: Record<string, unknown> = {}) =>
      operator.request(method, params) as Promise<Record<string, unknown>>;
    const preflight = async () =>
      ((await call(OperatorMethod.Preflight, { target: 'M1' })).failures as string[]) ?? [];
    const untilPreflight = async () => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const failures = await preflight();
        if (failures.length === 0) return;
        if (Date.now() > deadline) throw new Error(`预检未通过：${failures.join('；')}`);
        await sleep(500);
      }
    };

    // 1. 开播预检。
    await host.wait((l) => l.event === 'stage-page.authenticated', 30_000);
    await untilPreflight();
    ok(
      await obs.request('SetInputSettings', {
        inputName: stageSource,
        inputSettings: { reroute_audio: false },
        overlay: true,
      }),
    );
    const failing = await preflight();
    const refused = await call(OperatorMethod.Mode, { target: 'M1' });
    ok(
      await obs.request('SetInputSettings', {
        inputName: stageSource,
        inputSettings: { reroute_audio: true },
        overlay: true,
      }),
    );
    await untilPreflight();
    result.preflight = {
      passedBefore: true,
      withoutReroute: failing,
      modeRefused: refused,
      passedAfter: true,
    };
    console.log('预检：', JSON.stringify(result.preflight));

    // 2. M1：等待放行后播出。
    const m1 = await call(OperatorMethod.Mode, { target: 'M1' });
    if (m1.ok !== true) throw new Error(`进入 M1 失败：${JSON.stringify(m1)}`);
    let from = host.items.length;
    const held = await host.wait(fact('speech.held'), ANNOUNCE_EVERY_MS + 5000, from);
    const heldAt = Date.parse(held.t);
    const status = await call(OperatorMethod.Status);
    const played = await host.wait(fact('utterance.played'), 20_000, from);
    result.m1Release = {
      heldVisibleInStatus: (status.held as unknown[]).length,
      firstSoundAfterHeldMs: (loud.find((t) => t > heldAt) ?? Number.NaN) - heldAt,
      utterance: played.data,
    };
    console.log('M1 放行：', JSON.stringify(result.m1Release));

    // 3. M1：否决。
    from = host.items.length;
    const heldAgain = await host.wait(fact('speech.held'), ANNOUNCE_EVERY_MS + 5000, from);
    const vetoAt = Date.now();
    const veto = await call(OperatorMethod.Veto);
    const vetoedPlay = await host.wait(fact('utterance.played'), 20_000, from);
    await sleep(DELAY_MS + 1000);
    result.m1Veto = {
      held: (heldAgain.data as { key: string }).key,
      veto,
      utterance: vetoedPlay.data,
      loudReadingsAfterVeto: loudBetween(vetoAt, Date.now()),
    };
    console.log('M1 否决：', JSON.stringify(result.m1Veto));

    // 4. M2：确认在场后直接播出。
    await call(OperatorMethod.Presence);
    const m2 = await call(OperatorMethod.Mode, { target: 'M2' });
    if (m2.ok !== true) throw new Error(`进入 M2 失败：${JSON.stringify(m2)}`);
    from = host.items.length;
    const m2Played = await host.wait(fact('utterance.played'), ANNOUNCE_EVERY_MS + 10_000, from);
    result.m2 = {
      utterance: m2Played.data,
      heldInM2: host.items.slice(from).filter(fact('speech.held')).length,
      loudReadings: loudBetween(Date.parse(m2Played.t) - 6000, Date.parse(m2Played.t)),
    };
    console.log('M2：', JSON.stringify(result.m2));

    // 5. 急停后没有新的输出。
    const estopAt = Date.now();
    await call(OperatorMethod.EmergencyStop, { reason: '演练：急停后无输出' });
    ok(await obs.request('SetCurrentProgramScene', { sceneName: original.scene }));
    ok(await obs.request('SetInputMute', { inputName: stageSource, inputMuted: false }));
    from = host.items.length;
    await sleep(2 * ANNOUNCE_EVERY_MS);
    const after = host.items.slice(from).filter(fact('utterance.played'));
    result.afterEstop = {
      observedMs: Date.now() - estopAt,
      utterances: after.map((l) => l.data),
      loudReadings: loudBetween(estopAt + 500, Date.now()),
    };
    console.log('急停后：', JSON.stringify(result.afterEstop));
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
  const out = resolve(values.out ?? join('reports', `drill-output-${started.slice(0, 10)}.json`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    `${JSON.stringify({ drill: 'output', started, finished: new Date().toISOString(), node: process.version, stageSource, safeScene, delayMs: DELAY_MS, ...result }, null, 2)}\n`,
  );
  console.log(`结果已写入 ${out}`);
}

await main();
