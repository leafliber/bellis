import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { connect, decodeSessionKey, RpcPeer } from '@bellis/channel';
import { SIM_OBS_SECRET, writeObsSecret } from '@bellis/config';
import { EventSubscription, INPUT_VOLUME_METERS, SimObs } from '@bellis/obs';
import { OperatorConsoleLoginResult, OperatorMethod, Role } from '@bellis/protocol';
import { KeyringSecretStore, readSessionInfo } from '@bellis/secret-store';
import { Compile } from 'typebox/compile';
import { launch } from '../src/launch.ts';

type LogLine = { event: string; [field: string]: unknown };

/** 收集子进程的结构化日志，等待某个事件出现。 */
class EventLog {
  readonly lines: LogLine[] = [];
  #waiters: Array<() => void> = [];

  constructor(stream: Readable | null) {
    if (!stream) throw new Error('没有可读的输出');
    createInterface({ input: stream }).on('line', (line) => {
      this.lines.push(JSON.parse(line) as LogLine);
      for (const wake of this.#waiters.splice(0)) wake();
    });
  }

  has(event: string): boolean {
    return this.lines.some((line) => line.event === event);
  }

  wait(event: string, timeoutMs = 10_000): Promise<LogLine> {
    return this.waitFor((line) => line.event === event, timeoutMs);
  }

  async waitFor(match: (line: LogLine) => boolean, timeoutMs = 10_000): Promise<LogLine> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.lines.find(match);
      if (found) return found;
      if (Date.now() > deadline)
        throw new Error(`未等到期望的日志：${JSON.stringify(this.lines.slice(-20))}`);
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  }
}

const script = (specifier: string) => fileURLToPath(import.meta.resolve(specifier));
const simConfig = fileURLToPath(new URL('../../../config/sim.json', import.meta.url));

/** 测试用的快速 profile：弹幕很快到达，模拟 TTS 每字 20ms。 */
function fastProfile(
  moderationDisabled: boolean | undefined,
  extra: readonly Record<string, unknown>[] = [],
) {
  const moderation: Record<string, unknown> = { id: 'moderation', plugin: 'moderation' };
  if (moderationDisabled !== undefined) moderation.disabled = moderationDisabled;
  return {
    name: 'test',
    packs: [
      {
        name: 'all',
        entries: [
          { id: 'stage-page', plugin: 'stage-page-sim' },
          { id: 'stage', plugin: 'stage-service' },
          { id: 'obs', plugin: 'obs-control', grant: ['obs.control'] },
          { id: 'tts', plugin: 'tts-sim', config: { samplesPerChar: 320 } },
          { id: 'speech', plugin: 'speech-arbiter', grant: ['speech.output'] },
          { id: 'moderation-model', plugin: 'moderation-model-sim' },
          moderation,
          {
            id: 'danmaku',
            plugin: 'danmaku-replay',
            config: {
              messages: [{ atMs: 1500, id: 'd1', viewer: 'v1', nickname: '小明', text: '你好' }],
            },
          },
          { id: 'triage', plugin: 'audience-triage' },
          {
            id: 'llm',
            plugin: 'llm-replay',
            config: {
              outputs: [JSON.stringify({ action: 'speak', text: '你好，欢迎。', replyTo: 'c-d1' })],
            },
          },
          { id: 'director', plugin: 'director' },
          ...extra,
        ],
      },
    ],
  };
}

async function start(
  options: {
    moderationDisabled?: boolean | undefined;
    extra?: readonly Record<string, unknown>[];
  } = { moderationDisabled: false },
) {
  // 独立的服务名与临时存储，不碰真实的 bellis 条目与本机运行数据。
  const id = randomBytes(4).toString('hex');
  const service = `bellis-test-${id}`;
  const store = new KeyringSecretStore(service);
  const obs = await SimObs.start();
  await writeObsSecret(store, { url: obs.url }, SIM_OBS_SECRET);
  const dbPath = join(tmpdir(), `bellis-launch-${id}.db`);
  const configPath = join(tmpdir(), `bellis-launch-${id}.json`);
  const profilePath = join(tmpdir(), `bellis-launch-${id}.profile.json`);
  const config = JSON.parse(readFileSync(simConfig, 'utf8'));
  writeFileSync(
    profilePath,
    JSON.stringify(fastProfile(options.moderationDisabled, options.extra)),
  );
  writeFileSync(configPath, JSON.stringify({ ...config, storePath: dbPath, profile: profilePath }));
  const cleanup = async () => {
    await store.delete(SIM_OBS_SECRET);
    await obs.close();
    for (const path of [configPath, profilePath, dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      rmSync(path, { force: true });
    }
  };
  try {
    const session = await launch({
      configPath,
      secretService: service,
      host: { command: process.execPath, args: [script('@bellis/host/main')] },
      watchdog: { command: process.execPath, args: [script('@bellis/watchdog/main')] },
      stdout: 'pipe',
    });
    return {
      store,
      obs,
      session,
      host: new EventLog(session.host.stdout),
      watchdog: new EventLog(session.watchdog.stdout),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('条件未在时限内满足');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('启动器分别拉起宿主与看门狗；计划内停止时宿主自己切安全场景，看门狗不动作', async () => {
  const s = await start();
  try {
    const hostReady = await s.host.wait('host.ready');
    const watchdogReady = await s.watchdog.wait('watchdog.ready');
    await s.watchdog.wait('watchdog.connected');

    // 两者都是启动器的子进程，看门狗不是宿主的子进程。
    assert.equal(hostReady.ppid, process.pid);
    assert.equal(watchdogReady.ppid, process.pid);
    assert.equal(hostReady.mode, 'safe-stop');
    assert.deepEqual(await readSessionInfo(s.store), s.session.info);

    const result = await s.session.stop();
    assert.equal(result.host.stage, 'shutdown');
    assert.equal(result.watchdog.stage, 'stdin-eof');
    await s.watchdog.wait('watchdog.host-stopped');
    assert.equal(s.watchdog.has('watchdog.acting'), false);
    assert.equal(s.obs.currentScene, 'Safe');
    assert.equal(await readSessionInfo(s.store), undefined);
  } finally {
    await s.cleanup();
  }
});

test('加载插件超过心跳超时（sidecar 启动慢）时宿主照常发心跳，看门狗不动作', async () => {
  // 假后端的 sidecar 先等 1.5 秒再连宿主，超过看门狗的心跳超时（1 秒）；心跳在加载插件之前就开始。
  const s = await start({
    moderationDisabled: false,
    extra: [
      {
        id: 'tts-local',
        plugin: 'tts-local',
        config: { backend: 'fake', fake: { startupDelayMs: 1500 } },
      },
    ],
  });
  try {
    await s.watchdog.wait('watchdog.connected');
    await s.host.waitFor((line) => line.event === 'tts-local.ready', 15_000);
    await s.host.wait('host.ready');
    assert.equal(s.watchdog.has('watchdog.acting'), false);
    assert.equal(s.obs.currentScene, 'Live');
  } finally {
    await s.session.stop();
    await s.cleanup();
  }
});

test('宿主崩溃后看门狗仍在运行，静音 Stage 源、切安全场景并呼叫操作员', async () => {
  const s = await start();
  try {
    await s.watchdog.wait('watchdog.connected');
    assert.equal(s.obs.currentScene, 'Live');
    s.session.host.kill();
    await s.session.host.exited;
    const acted = await s.watchdog.wait('watchdog.acted');
    assert.equal(acted.ok, true);
    await s.watchdog.wait('watchdog.paged');
    assert.equal(s.obs.currentScene, 'Safe');
    assert.equal(s.obs.muted.get('Stage'), true);
    assert.equal(s.session.watchdog.status, undefined);
  } finally {
    const result = await s.session.stop();
    assert.equal(result.host.stage, 'already-exited');
    assert.equal(result.watchdog.stage, 'stdin-eof');
    await s.cleanup();
  }
});

test('看门狗意外退出后由启动器重启，并重新连上宿主', async () => {
  const s = await start();
  try {
    const first = s.session.watchdog;
    first.kill();
    await first.exited;
    await until(() => s.session.watchdog !== first);
    assert.notEqual(s.session.watchdog.pid, first.pid);
    const restarted = new EventLog(s.session.watchdog.stdout);
    await restarted.wait('watchdog.connected');
  } finally {
    const result = await s.session.stop();
    assert.equal(result.watchdog.stage, 'stdin-eof');
    await s.cleanup();
  }
});

test('操作员切到 M0 后，录制弹幕经全模拟链路得到回应', async () => {
  const s = await start();
  try {
    await s.host.wait('host.ready');
    const connection = await connect(s.session.info.channelPath, Role.Operator, {
      key: decodeSessionKey(s.session.info.channelKey),
    });
    const operator = new RpcPeer(connection, { timeoutMs: 5000 });
    assert.deepEqual(await operator.request(OperatorMethod.Mode, { target: 'M1' }), {
      ok: false,
      reason: 'sim profile 下只允许 M0',
    });
    assert.deepEqual(await operator.request(OperatorMethod.Mode, { target: 'M0' }), { ok: true });
    // OBS 控制经宿主交出的连接连上了模拟 OBS。
    await s.host.waitFor((line) => line.event === 'obs-control.connected', 5000);
    const status = (await operator.request(OperatorMethod.Status)) as {
      plugins: Array<{ id: string; state: string }>;
    };
    assert.equal(status.plugins.find((plugin) => plugin.id === 'obs')?.state, 'active');
    const fact = await s.host.waitFor(
      (line) => line.event === 'fact' && line.type === 'utterance.played',
      15_000,
    );
    assert.equal((fact.data as { heard: string }).heard, '你好，欢迎。');
    connection.close();
  } finally {
    await s.session.stop();
    await s.cleanup();
  }
});

test('呈现延迟：宿主另开只订阅音量表的连接交给被授予 obs.meters 的 stage-sync，操作员状态里能看到 D 与样本数', async () => {
  const s = await start({
    moderationDisabled: false,
    extra: [
      { id: 'sync', plugin: 'stage-sync', grant: ['obs.meters'] },
      { id: 'sync-ungranted', plugin: 'stage-sync' },
    ],
  });
  try {
    await s.host.wait('host.ready');
    await s.host.waitFor((line) => line.event === 'stage-sync.meters-connected', 5000);
    // 安全核的应急连接只订阅场景与输入（R-27），OBS 控制与看门狗的连接不订阅事件，
    // 音量表连接只订阅 InputVolumeMeters。
    assert.deepEqual(
      s.obs.subscriptions.filter((bits) => bits !== 0).sort((a, b) => a - b),
      [EventSubscription.Scenes | EventSubscription.Inputs, INPUT_VOLUME_METERS],
    );
    const connection = await connect(s.session.info.channelPath, Role.Operator, {
      key: decodeSessionKey(s.session.info.channelKey),
    });
    const operator = new RpcPeer(connection, { timeoutMs: 5000 });
    const status = (await operator.request(OperatorMethod.Status)) as {
      presentation: unknown;
      plugins: Array<{ id: string; state: string; reason: string | null }>;
    };
    assert.deepEqual(status.presentation, { delayMs: 82, samples: 0, source: 'initial' });
    const ungranted = status.plugins.find((plugin) => plugin.id === 'sync-ungranted');
    assert.equal(ungranted?.state, 'waiting');
    assert.match(String(ungranted?.reason), /未授予权限 obs\.meters/);
    connection.close();
  } finally {
    await s.session.stop();
    await s.cleanup();
  }
});

/** 以操作台页面的身份发请求（同源）。 */
function consoleRequest(
  url: string,
  method: 'GET' | 'POST',
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; body: unknown; setCookie: string[] }> {
  const { host, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: Number(port),
        method,
        path,
        agent: false,
        headers: {
          host,
          origin: `http://${host}`,
          'sec-fetch-site': 'same-origin',
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            body: text ? JSON.parse(text) : null,
            setCookie: ([] as string[]).concat(res.headers['set-cookie'] ?? []),
          });
        });
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('宿主启动时开启操作台：命令行取一次性令牌登录后，经操作台看状态、确认在场；宿主停止时关闭', async () => {
  const s = await start();
  let url: string | undefined;
  try {
    await s.host.wait('host.ready');
    const listening = await s.host.wait('console.listening');
    const connection = await connect(s.session.info.channelPath, Role.Operator, {
      key: decodeSessionKey(s.session.info.channelKey),
    });
    const operator = new RpcPeer(connection, { timeoutMs: 5000 });
    const login = await operator.request(OperatorMethod.ConsoleLogin, {});
    assert.ok(Compile(OperatorConsoleLoginResult).Check(login));
    url = login.url;
    assert.equal(url, `http://127.0.0.1:${listening.port}/`);
    connection.close();

    const loggedIn = await consoleRequest(url, 'POST', '/api/login', {}, { token: login.token });
    assert.equal(loggedIn.status, 200);
    const cookie = loggedIn.setCookie[0]?.split(';')[0] ?? '';
    const csrf = (loggedIn.body as { csrf: string }).csrf;
    const status = await consoleRequest(url, 'GET', '/api/status', { cookie });
    assert.equal(status.status, 200);
    const body = status.body as {
      mode: string;
      moderationEnabled: boolean;
      alerts: Array<{ type: string; text: string }>;
    };
    assert.equal(body.mode, 'safe-stop');
    assert.equal(body.moderationEnabled, true);
    // 宿主启动时报告的审核开关也在近期告警里。
    assert.deepEqual(
      body.alerts.filter((a) => a.type === 'moderation.switched').map((a) => a.text),
      ['审核插件已启用'],
    );
    const presence = await consoleRequest(
      url,
      'POST',
      '/api/presence',
      { cookie, 'x-bellis-csrf': csrf },
      {},
    );
    assert.deepEqual(presence.body, { ok: true });
    // 令牌用过即作废。
    assert.equal(
      (await consoleRequest(url, 'POST', '/api/login', {}, { token: login.token })).status,
      403,
    );
  } finally {
    await s.session.stop();
    await s.cleanup();
  }
  assert.ok(url);
  await assert.rejects(consoleRequest(url, 'GET', '/api/status', {}));
});

test('profile 没有显式设置审核插件的开关时，宿主拒绝启动', async () => {
  await assert.rejects(start({ moderationDisabled: undefined }), /宿主在就绪前退出/);
});
