import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { test } from 'node:test';
import type { VoteStatus } from '@bellis/audience';
import {
  type Connection,
  connect,
  createChannelPath,
  createSessionKey,
  listen,
  RpcPeer,
} from '@bellis/channel';
import { ConsoleServer } from '@bellis/console';
import { ManualClock } from '@bellis/kernel';
import { SimObs } from '@bellis/obs';
import { OperatorConsoleLoginResult, OperatorMethod } from '@bellis/protocol';
import { ObsEmergencyConnection, SafetyCore } from '@bellis/safety';
import { StateStore } from '@bellis/store';
import { Compile } from 'typebox/compile';
import {
  consoleRoutes,
  createOperator,
  type OperatorStatus,
  serveOperator,
} from '../src/operator.ts';

const isLogin = Compile(OperatorConsoleLoginResult);

/** 宿主装配的一部分：安全核（模拟 OBS）、操作员动作、本机通道上的命令行入口与操作台。 */
async function setup(options: { alertLimit?: number } = {}) {
  const store = StateStore.open({ path: ':memory:' });
  const clock = new ManualClock();
  const obs = await SimObs.start();
  const logs: string[] = [];
  const emergency = new ObsEmergencyConnection({ url: obs.url }, clock, (event) =>
    logs.push(event),
  );
  await emergency.start();
  const core = new SafetyCore({
    store,
    clock,
    config: {
      simulation: false,
      leaseTtlMs: { 'stage.audio': 2000 },
      leaseCapabilities: { 'stage.audio': 'speech.output' },
      presenceTtlMs: 60_000,
      rateLimits: {},
      guardTimeoutMs: 200,
      emergency: { stageSource: 'Stage', safeScene: 'Safe', stopStream: false },
      unattendedGatesSatisfied: false,
    },
    obs: emergency,
    permissionsOf: () => new Set(),
    watchdogConnected: () => true,
  });
  core.setModeration(false);
  const world = {
    failures: [] as string[],
    preflights: [] as Array<[string, boolean]>,
    vote: null as VoteStatus | null,
  };
  let server: ConsoleServer | undefined;
  const api = createOperator({
    core,
    subscribe: (listener) => store.subscribe(listener),
    plugins: () => [
      {
        id: 'review',
        plugin: 'speech-review',
        version: '0.1.0',
        tier: 'ordinary',
        process: 'in-process',
        state: 'waiting',
        reason: '缺少服务 safety@1',
        instanceId: undefined,
        enabled: true,
      },
    ],
    presentation: () => ({ delayMs: 82, samples: 0, source: 'initial' }),
    review: () => ({ mode: 'approve', delayMs: 3000, approveTimeoutMs: 30_000 }),
    vote: () => world.vote,
    preflight: async (target, withSafety) => {
      world.preflights.push([target, withSafety]);
      return [...world.failures];
    },
    consoleLogin: () => server?.issueLogin(),
    now: () => 1_000_000 + clock.now(),
    ...(options.alertLimit ? { alertLimit: options.alertLimit } : {}),
  });
  server = await ConsoleServer.start({ routes: consoleRoutes(api), log: () => {} });

  // 本机通道上的 operator 角色，与宿主的装配相同。
  const path = createChannelPath(`t${randomBytes(4).toString('hex')}`);
  const key = createSessionKey();
  const accepted = Promise.withResolvers<Connection>();
  const channel = await listen(path, {
    key,
    onConnection: accepted.resolve,
    onRejected: () => {},
    onError: (error) => {
      throw error;
    },
  });
  const client = await connect(path, 'operator', { key });
  serveOperator(new RpcPeer(await accepted.promise, { timeoutMs: 5000 }), api);
  const cli = new RpcPeer(client, { timeoutMs: 5000 });

  // 操作台：用命令行拿到的一次性令牌登录。
  const login = await cli.request(OperatorMethod.ConsoleLogin, {});
  assert.ok(isLogin.Check(login));
  const port = server.port;
  const origin = `http://127.0.0.1:${port}`;
  const http = (method: 'GET' | 'POST', path: string, body?: unknown, extra = {}) =>
    new Promise<{ status: number; body: unknown; setCookie: string[] }>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          agent: false,
          headers: {
            host: `127.0.0.1:${port}`,
            origin,
            'sec-fetch-site': 'same-origin',
            ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
            ...(session ? { cookie: session.cookie, 'x-bellis-csrf': session.csrf } : {}),
            ...extra,
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
  let session: { cookie: string; csrf: string } | undefined;
  const loggedIn = await http('POST', '/api/login', { token: login.token });
  assert.equal(loggedIn.status, 200);
  session = {
    cookie: loggedIn.setCookie[0]?.split(';')[0] ?? '',
    csrf: (loggedIn.body as { csrf: string }).csrf,
  };
  return {
    core,
    store,
    clock,
    obs,
    logs,
    api,
    world,
    cli,
    http,
    events: (type: string) => store.events().filter((e) => e.type === type),
    async close() {
      api.dispose();
      client.close();
      await channel.close();
      await server?.close();
      emergency.close();
      store.close();
      await obs.close();
    },
  };
}

test('命令行（RPC）与操作台（HTTP）调同一套操作员动作：结果与记录一致', async () => {
  const s = await setup();
  try {
    // 状态：内容相同，操作台另加近期告警。
    const fromCli = (await s.cli.request(OperatorMethod.Status)) as OperatorStatus;
    const fromConsole = await s.http('GET', '/api/status');
    assert.equal(fromConsole.status, 200);
    const { alerts, ...rest } = fromConsole.body as OperatorStatus & { alerts: unknown[] };
    assert.deepEqual(rest, fromCli);
    assert.deepEqual(alerts, []);
    assert.equal(fromCli.mode, 'safe-stop');
    assert.equal(fromCli.moderationEnabled, false);
    assert.deepEqual(fromCli.review, { mode: 'approve', delayMs: 3000, approveTimeoutMs: 30_000 });
    assert.deepEqual(fromCli.plugins, [
      { id: 'review', plugin: 'speech-review', state: 'waiting', reason: '缺少服务 safety@1' },
    ]);

    // 确认在场。
    assert.deepEqual(await s.cli.request(OperatorMethod.Presence), { ok: true });
    assert.deepEqual((await s.http('POST', '/api/presence', {})).body, { ok: true });
    assert.equal(s.events('presence.confirmed').length, 2);
    const status = (await s.cli.request(OperatorMethod.Status)) as OperatorStatus;
    assert.equal(status.presenceValid, true);
    assert.equal(status.presenceRemainingMs, 60_000);

    // 开播预检未通过时不切换，两边都记一条 supervision.refused。
    s.world.failures = ['Stage 页面尚未认证'];
    const refused = {
      ok: false,
      reason: '开播预检未通过',
      failures: ['Stage 页面尚未认证'],
    };
    assert.deepEqual(await s.cli.request(OperatorMethod.Mode, { target: 'M2' }), refused);
    assert.deepEqual((await s.http('POST', '/api/mode', { target: 'M2' })).body, refused);
    assert.equal(s.events('supervision.refused').length, 2);
    assert.deepEqual(s.world.preflights, [
      ['M2', false],
      ['M2', false],
    ]);

    // 参数不合法：命令行回 ok:false，操作台回 400，都不切换、不记录。
    const invalid = { ok: false, reason: '参数不合法' };
    assert.deepEqual(await s.cli.request(OperatorMethod.Mode, { target: 'M9' }), invalid);
    const bad = await s.http('POST', '/api/mode', { target: 'M9' });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body, invalid);
    assert.deepEqual(await s.cli.request(OperatorMethod.Preflight, { target: 'm2' }), invalid);
    assert.equal((await s.http('POST', '/api/veto', { key: 5 })).status, 400);
    assert.equal(s.events('supervision.refused').length, 2);

    // 只跑预检：先列安全核的前置条件；最近一次结果进状态。
    s.world.failures = [];
    const preflight = { target: 'M1', failures: [] };
    assert.deepEqual(await s.cli.request(OperatorMethod.Preflight, { target: 'M1' }), preflight);
    assert.deepEqual((await s.http('POST', '/api/preflight', { target: 'M1' })).body, preflight);
    assert.deepEqual(s.world.preflights.slice(-2), [
      ['M1', true],
      ['M1', true],
    ]);
    const after = (await s.http('GET', '/api/status')).body as OperatorStatus;
    assert.deepEqual(
      { ...after.preflight, at: undefined },
      { target: 'M1', failures: [], by: 'preflight', at: undefined },
    );

    // 切到 M2，再从操作台急停：急停的参数不合法也照样急停，用缺省原因。
    assert.deepEqual((await s.http('POST', '/api/mode', { target: 'M2' })).body, { ok: true });
    assert.equal(s.core.mode, 'M2');
    const estop = await s.http('POST', '/api/emergency-stop', { reason: 5 });
    assert.equal(estop.status, 200);
    assert.deepEqual(estop.body, { reason: '操作员急停', revoked: 0, obs: { ok: true } });
    assert.equal(s.core.mode, 'safe-stop');
    const cliStop = await s.cli.request(OperatorMethod.EmergencyStop, { reason: '命令行急停' });
    assert.deepEqual(cliStop, { reason: '命令行急停', revoked: 0, obs: { ok: true } });
    assert.deepEqual(
      s.events('safety.emergency-requested').map((e) => (e.data as { reason: string }).reason),
      ['操作员急停', '命令行急停'],
    );
  } finally {
    await s.close();
  }
});

test('等待放行的句子：状态里看得到等待方式与等了多久；逐句或全部放行、否决经控制通道送达', async () => {
  const s = await setup();
  try {
    // 代替 speech-review：控制通道上的放行与否决记成结束事件。
    s.core.control.subscribe((signal) => {
      if (signal.kind !== 'release' && signal.kind !== 'veto') return;
      for (const key of signal.key === undefined ? ['u1#0', 'u1#1', 'u2#0'] : [signal.key]) {
        if (!held.has(key)) continue;
        held.delete(key);
        if (signal.kind === 'release') s.core.record('speech.released', { key, by: 'operator' });
        else
          s.core.record('speech.vetoed', { key, subtitle: `字幕 ${key}`, reason: signal.reason });
      }
    });
    const held = new Set<string>();
    for (const key of ['u1#0', 'u1#1', 'u2#0']) {
      held.add(key);
      s.core.record('speech.held', {
        key,
        utteranceId: key.split('#')[0],
        index: Number(key.split('#')[1]),
        source: 'reply',
        subtitle: `字幕 ${key}`,
        mode: 'approve',
        timeoutMs: 30_000,
      });
    }
    s.clock.advance(1500);
    const status = (await s.cli.request(OperatorMethod.Status)) as OperatorStatus;
    assert.deepEqual(
      status.held.map((h) => [h.key, h.mode, h.timeoutMs, h.waitedMs, h.subtitle]),
      [
        ['u1#0', 'approve', 30_000, 1500, '字幕 u1#0'],
        ['u1#1', 'approve', 30_000, 1500, '字幕 u1#1'],
        ['u2#0', 'approve', 30_000, 1500, '字幕 u2#0'],
      ],
    );

    assert.deepEqual((await s.http('POST', '/api/release', { key: 'u1#0' })).body, {
      ok: true,
      released: ['u1#0'],
    });
    // 不在等待中的句键：送达了，但没有句子被处理。
    assert.deepEqual(await s.cli.request(OperatorMethod.Release, { key: 'nope#0' }), {
      ok: true,
      released: [],
    });
    assert.deepEqual(await s.cli.request(OperatorMethod.Veto, {}), {
      ok: true,
      vetoed: ['u1#1', 'u2#0'],
    });
    const after = (await s.http('GET', '/api/status')).body as OperatorStatus & {
      alerts: Array<{ type: string; text: string }>;
    };
    assert.deepEqual(after.held, []);
    assert.deepEqual(
      after.alerts.map((a) => a.text),
      ['已否决：字幕 u1#1', '已否决：字幕 u2#0'],
    );
  } finally {
    await s.close();
  }
});

test('近期告警环形保存最近的重要事实，普通事实不进告警', async () => {
  const s = await setup({ alertLimit: 3 });
  try {
    s.core.record('presence.confirmed', { ttlMs: 1 });
    s.core.record('danmaku.gap-started', { platform: 'bilibili', reason: '心跳失败' });
    s.core.record('tts.switched', { from: 'local', to: 'subtitles', reason: '模型加载中' });
    s.core.record('speech.withdrawn', { key: 'a#0', reason: '监督模式已切到 M2' });
    s.core.record('speech.withdrawn', {
      key: 'b#0',
      reason: '等待放行超时（30000ms）',
      timedOut: true,
    });
    s.core.record('safety.obs-external', {
      change: 'mute',
      input: 'Stage',
      resync: false,
      mode: 'M2',
    });
    const status = (await s.http('GET', '/api/status')).body as {
      alerts: Array<{ type: string; text: string; at: string }>;
    };
    assert.deepEqual(
      status.alerts.map((a) => [a.type, a.text]),
      [
        ['tts.switched', 'TTS 换引擎：local → subtitles（模型加载中）'],
        ['speech.withdrawn', '等待放行超时，已撤回：b#0'],
        ['safety.obs-external', 'OBS 外部静音了 Stage 源「Stage」'],
      ],
    );
    assert.ok(status.alerts.every((a) => !Number.isNaN(Date.parse(a.at))));
  } finally {
    await s.close();
  }
});

test('进行中的投票：命令行与操作台的状态里看得到题目、票数与剩余时间；中止进近期告警', async () => {
  const s = await setup();
  try {
    assert.equal(((await s.cli.request(OperatorMethod.Status)) as OperatorStatus).vote, null);
    s.world.vote = {
      voteId: 'director:1',
      question: '下一把玩什么?',
      options: ['魔女审判', '逆转裁判'],
      counts: [2, 1],
      valid: 3,
      phase: 'open',
      durationMs: 30_000,
      remainingMs: 12_000,
      decisionPoint: null,
      gap: false,
    };
    const fromCli = (await s.cli.request(OperatorMethod.Status)) as OperatorStatus;
    assert.deepEqual(fromCli.vote, s.world.vote);
    const fromConsole = (await s.http('GET', '/api/status')).body as OperatorStatus;
    assert.deepEqual(fromConsole.vote, s.world.vote);
    s.core.record('vote.aborted', {
      voteId: 'director:1',
      decisionPoint: null,
      cause: 'stopped',
      reason: '安全停止：操作员急停',
    });
    assert.deepEqual(
      s.api.alerts().map((a) => a.text),
      ['投票中止：director:1（安全停止：操作员急停）'],
    );
  } finally {
    await s.close();
  }
});

test('决策模型连续失败或漂移的告警进近期告警', async () => {
  const s = await setup();
  try {
    s.core.record('director.alarmed', { cause: 'failures', count: 3, detail: 'timeout' });
    s.core.record('director.alarmed', { cause: 'drift', count: 3, detail: 'repeat,phrase' });
    assert.deepEqual(
      s.api.alerts().map((a) => a.text),
      [
        '决策模型连续失败 3 次（最近一次：timeout），已请求降级',
        '决策输出连续 3 次重复或漂移（repeat,phrase），已请求降级',
      ],
    );
  } finally {
    await s.close();
  }
});

test('操作台没有启动时，命令行要登录令牌得到明确的拒绝', async () => {
  const store = StateStore.open({ path: ':memory:' });
  const core = new SafetyCore({
    store,
    clock: new ManualClock(),
    config: {
      simulation: false,
      leaseTtlMs: {},
      leaseCapabilities: {},
      presenceTtlMs: 1000,
      rateLimits: {},
      guardTimeoutMs: 200,
      emergency: { stageSource: 'Stage', safeScene: 'Safe', stopStream: false },
      unattendedGatesSatisfied: false,
    },
    obs: { ready: false, run: async () => ({ ok: false, results: [] }) },
    permissionsOf: () => undefined,
    watchdogConnected: () => false,
  });
  const api = createOperator({
    core,
    subscribe: (listener) => store.subscribe(listener),
    plugins: () => [],
    presentation: () => null,
    review: () => null,
    preflight: async () => [],
    consoleLogin: () => undefined,
  });
  try {
    assert.deepEqual(api.consoleLogin(), { ok: false, reason: '操作台没有启动' });
    assert.equal(api.status().review, null);
  } finally {
    api.dispose();
    store.close();
  }
});
