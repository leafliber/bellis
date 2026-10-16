/**
 * 探针 S-10：看门狗在宿主崩溃、事件循环阻塞、管道断开时多快把真实 OBS 切到安全场景（见 docs/plan/spikes.md）。
 *
 *   node spikes/s10-watchdog.ts --stage-source 名字 [--safe-scene Safe] [--create-safe-scene] [--trials N]
 *                               [--heartbeat-timeout-ms 1000]
 *     --create-safe-scene  安全场景不存在时创建一个同名的空场景（不会删除）。
 *
 * 看门狗是真实的看门狗进程（packages/watchdog/src/main.ts），按启动器的方式拉起，从 SecretStore 读连接信息；
 * 宿主一侧换成本脚本的子进程（--fake-host），按 250ms 发心跳，可以被强制终止、阻塞事件循环或主动断开管道。
 * 时间从注入故障的墙钟时刻算到看门狗日志里的 watchdog.acting / watchdog.acted（RequestBatch 已在 OBS 执行完），
 * 之后再从 OBS 读回节目场景与静音状态核对。
 *
 * 会切换 OBS 的节目场景并静音 Stage 源；推流或录制进行中时拒绝运行，结束后恢复原来的场景与静音状态。
 * 用一个临时的 SecretStore 服务名存放本次的会话信息与 OBS 凭据副本，结束时删除，不碰 bellis 下的条目。
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  type Connection,
  createChannelPath,
  createSessionKey,
  decodeSessionKey,
  encodeSessionKey,
  listen,
  RpcPeer,
} from '@bellis/channel';
import { loadConfig, OBS_SECRET, readObsSecret, writeObsSecret } from '@bellis/config';
import { ObsClient, type ObsResult } from '@bellis/obs';
import { ChildEnv, HostHeartbeat } from '@bellis/protocol';
import { KeyringSecretStore, SESSION_SECRET, writeSessionInfo } from '@bellis/secret-store';

const script = fileURLToPath(import.meta.url);
const watchdogMain = fileURLToPath(new URL('../packages/watchdog/src/main.ts', import.meta.url));
const liveExample = fileURLToPath(new URL('../config/live.example.json', import.meta.url));
const HEARTBEAT_MS = 250;
const MODES = ['crash', 'block', 'disconnect'] as const;
type Mode = (typeof MODES)[number];

// ---------- 模拟宿主 ----------

async function fakeHost(): Promise<void> {
  const path = process.env[ChildEnv.ChannelPath] as string;
  const key = decodeSessionKey(process.env[ChildEnv.ChannelKey] as string);
  const peers = new Map<Connection, RpcPeer>();
  let seq = 0;
  const server = await listen(path, {
    key,
    onConnection: (connection) => {
      peers.set(connection, new RpcPeer(connection, { timeoutMs: 1000 }));
      connection.on('close', () => peers.delete(connection));
      process.stdout.write('connected\n');
    },
    onRejected: () => {},
    onError: () => {},
  });
  const timer = setInterval(() => {
    seq += 1;
    for (const rpc of peers.values()) {
      rpc.notify(HostHeartbeat, { seq, mode: 'M2', maintenance: false });
    }
  }, HEARTBEAT_MS);
  for await (const line of createInterface({ input: process.stdin })) {
    if (line === 'block') {
      // 事件循环卡死：进程与管道都还在，心跳停止。
      for (;;) {}
    }
    if (line === 'disconnect') {
      clearInterval(timer);
      for (const connection of peers.keys()) connection.destroy();
      await server.close();
      process.stdout.write('disconnected\n');
    }
  }
}

// ---------- 主进程 ----------

type LogLine = { t: string; event: string; [field: string]: unknown };

/** 逐行收集子进程的 JSON 日志或文本输出，等待某一行出现。 */
class Lines<T> {
  readonly items: T[] = [];
  #waiters = new Set<() => void>();

  constructor(proc: ChildProcess, parse: (line: string) => T | undefined) {
    if (!proc.stdout) throw new Error('没有可读的输出');
    createInterface({ input: proc.stdout }).on('line', (line) => {
      const item = parse(line);
      if (item === undefined) return;
      this.items.push(item);
      for (const wake of this.#waiters) wake();
    });
  }

  async wait(match: (item: T) => boolean, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.items.find(match);
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

function exited(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((done) => proc.once('exit', () => done()));
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
    max: sorted.at(-1) ?? 0,
  };
}

async function trial(options: {
  mode: Mode;
  service: string;
  configPath: string;
  obs: ObsClient;
  stageSource: string;
  safeScene: string;
}) {
  const sessionId = randomBytes(4).toString('hex');
  const channelPath = createChannelPath(sessionId);
  const key = createSessionKey();
  const store = new KeyringSecretStore(options.service);
  await writeSessionInfo(store, {
    v: 1,
    sessionId,
    channelPath,
    channelKey: encodeSessionKey(key),
    launcherPid: process.pid,
    startedAt: new Date().toISOString(),
  });
  const host = spawn(process.execPath, [script, '--fake-host'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
    env: {
      ...process.env,
      [ChildEnv.ChannelPath]: channelPath,
      [ChildEnv.ChannelKey]: encodeSessionKey(key),
    },
  });
  const hostLines = new Lines(host, (line) => line);
  const watchdog = spawn(process.execPath, [watchdogMain], {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
    env: {
      ...process.env,
      [ChildEnv.Config]: options.configPath,
      [ChildEnv.SessionId]: sessionId,
      [ChildEnv.SecretService]: options.service,
    },
  });
  const log = new Lines<LogLine>(watchdog, (line) => {
    try {
      return JSON.parse(line) as LogLine;
    } catch {
      return undefined;
    }
  });
  try {
    await log.wait((line) => line.event === 'watchdog.obs-connected', 10_000);
    await log.wait((line) => line.event === 'watchdog.connected', 10_000);
    await hostLines.wait((line) => line === 'connected', 10_000);
    // 稳定收发几轮心跳后再注入故障。
    await new Promise((wait) => setTimeout(wait, 1500));
    const injectedAt = Date.now();
    if (options.mode === 'crash') host.kill();
    else host.stdin?.write(`${options.mode}\n`);
    const acting = await log.wait((line) => line.event === 'watchdog.acting', 10_000);
    const acted = await log.wait((line) => line.event === 'watchdog.acted', 10_000);
    const scene = ok(await options.obs.request('GetCurrentProgramScene'));
    const mute = ok(await options.obs.request('GetInputMute', { inputName: options.stageSource }));
    return {
      mode: options.mode,
      reason: acting.reason,
      actingMs: Date.parse(acting.t) - injectedAt,
      actedMs: Date.parse(acted.t) - injectedAt,
      batchOk: acted.ok === true,
      sceneOk: scene.currentProgramSceneName === options.safeScene,
      muteOk: mute.inputMuted === true,
    };
  } finally {
    watchdog.stdin?.end();
    host.kill();
    await Promise.all([exited(watchdog), exited(host)]);
    await store.delete(SESSION_SECRET);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'fake-host': { type: 'boolean', default: false },
      'stage-source': { type: 'string' },
      'safe-scene': { type: 'string', default: 'Safe' },
      'create-safe-scene': { type: 'boolean', default: false },
      trials: { type: 'string', default: '10' },
      'heartbeat-timeout-ms': { type: 'string', default: '1000' },
      out: { type: 'string' },
    },
  });
  if (values['fake-host']) return fakeHost();
  const stageSource = values['stage-source'];
  if (!stageSource) throw new Error('需要 --stage-source');
  const safeScene = values['safe-scene'];
  const heartbeatTimeoutMs = Number(values['heartbeat-timeout-ms']);

  const secret = await readObsSecret(new KeyringSecretStore('bellis'), OBS_SECRET);
  const obs = await ObsClient.connect(secret.url, secret.password);
  const service = `bellis-s10-${randomBytes(4).toString('hex')}`;
  const store = new KeyringSecretStore(service);
  const configPath = join(tmpdir(), `${service}.json`);
  const started = new Date().toISOString();
  const results: Array<Awaited<ReturnType<typeof trial>> | { mode: Mode; error: string }> = [];
  let original: { scene: string; muted: boolean } | undefined;
  try {
    if (ok(await obs.request('GetStreamStatus')).outputActive)
      throw new Error('推流进行中，拒绝运行');
    if (ok(await obs.request('GetRecordStatus')).outputActive)
      throw new Error('录制进行中，拒绝运行');
    const scenes = ok(await obs.request('GetSceneList'));
    if (!(scenes.scenes as Array<{ sceneName: string }>).some((s) => s.sceneName === safeScene)) {
      if (!values['create-safe-scene']) throw new Error(`没有安全场景「${safeScene}」`);
      // 安全场景是空场景：急停切过去即同时隐藏 Stage 与形象。
      ok(await obs.request('CreateScene', { sceneName: safeScene }));
      console.log(`已创建空的安全场景「${safeScene}」`);
    }
    original = {
      scene: scenes.currentProgramSceneName as string,
      muted: ok(await obs.request('GetInputMute', { inputName: stageSource }))
        .inputMuted as boolean,
    };
    if (original.scene === safeScene) throw new Error('节目场景已经是安全场景，无法观察切换');

    await writeObsSecret(store, secret, OBS_SECRET);
    const config = JSON.parse(JSON.stringify(loadConfig(liveExample)));
    config.watchdog.heartbeatTimeoutMs = heartbeatTimeoutMs;
    config.safety.emergency = { stageSource, safeScene, stopStream: false };
    config.storePath = join(tmpdir(), `${service}.db`);
    writeFileSync(configPath, JSON.stringify(config));

    for (let n = 0; n < Number(values.trials); n++) {
      for (const mode of MODES) {
        ok(await obs.request('SetCurrentProgramScene', { sceneName: original.scene }));
        ok(
          await obs.request('SetInputMute', { inputName: stageSource, inputMuted: original.muted }),
        );
        await new Promise((wait) => setTimeout(wait, 300));
        try {
          const result = await trial({ mode, service, configPath, obs, stageSource, safeScene });
          results.push(result);
          console.log(
            `${mode} #${n + 1}：acting ${result.actingMs}ms，acted ${result.actedMs}ms，场景 ${result.sceneOk}，静音 ${result.muteOk}`,
          );
        } catch (error) {
          results.push({ mode, error: (error as Error).message });
          console.log(`${mode} #${n + 1}：失败 ${(error as Error).message}`);
        }
      }
    }
  } finally {
    if (original) {
      await obs.request('SetCurrentProgramScene', { sceneName: original.scene });
      await obs.request('SetInputMute', { inputName: stageSource, inputMuted: original.muted });
    }
    obs.close();
    await store.delete(OBS_SECRET);
    await store.delete(SESSION_SECRET);
    rmSync(configPath, { force: true });
  }

  const summary: Record<string, unknown> = {};
  for (const mode of MODES) {
    const done = results.filter((r): r is Awaited<ReturnType<typeof trial>> => 'actedMs' in r);
    const mine = done.filter((r) => r.mode === mode);
    summary[mode] = {
      trials: results.filter((r) => r.mode === mode).length,
      failed: results.filter((r) => r.mode === mode && 'error' in r).length,
      allVerified: mine.every((r) => r.batchOk && r.sceneOk && r.muteOk),
      actingMs: summarize(mine.map((r) => r.actingMs)),
      actedMs: summarize(mine.map((r) => r.actedMs)),
    };
  }
  const out = resolve(values.out ?? join('reports', `S-10-${started.slice(0, 10)}.json`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    `${JSON.stringify({ spike: 'S-10', started, finished: new Date().toISOString(), node: process.version, heartbeatTimeoutMs, heartbeatIntervalMs: HEARTBEAT_MS, stageSource, safeScene, summary, results }, null, 2)}\n`,
  );
  console.log(JSON.stringify(summary, null, 2));
  console.log(`结果已写入 ${out}`);
}

await main();
