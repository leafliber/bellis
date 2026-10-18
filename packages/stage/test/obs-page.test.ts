import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ClockService,
  catalog,
  definePlugin,
  Kernel,
  type ResolvedEntry,
  systemClock,
} from '@bellis/kernel';
import { ObsClient, SimObs } from '@bellis/obs';
import { SafetyCore, SafetyService, STAGE_URL, safetyFacade } from '@bellis/safety';
import { StateStore } from '@bellis/store';
import Type from 'typebox';
import { WebSocket } from 'ws';
import { decodeAudio } from '../page/audio.js';
import {
  OBS_CONTROL,
  ObsConnectorService,
  obsControl,
  obsStagePage,
  type PlaybackResult,
  STAGE_AUDIO,
  type Stage,
  StageService,
  stageService,
} from '../src/index.ts';

function entry(id: string, plugin: string, grant: string[] = [], config = {}): ResolvedEntry {
  return { id, plugin, config, disabled: false, explicitSwitch: false, grant };
}

const until = async (condition: () => boolean, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('条件未在时限内满足');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

async function setup(pageConfig: Record<string, unknown> = {}) {
  const path = join(tmpdir(), `bellis-stage-page-${randomBytes(6).toString('hex')}.db`);
  const store = StateStore.open({ path });
  const clock = systemClock();
  const obs = await SimObs.start({ scenes: ['Live', 'Safe'], inputs: ['Stage'] });
  let kernel: Kernel | undefined;
  const core = new SafetyCore({
    store,
    clock,
    config: {
      simulation: false,
      leaseTtlMs: { [OBS_CONTROL]: 2000, [STAGE_URL]: 2000, [STAGE_AUDIO]: 2000 },
      leaseCapabilities: {
        [OBS_CONTROL]: 'obs.control',
        [STAGE_URL]: 'obs.control',
        [STAGE_AUDIO]: 'speech.output',
      },
      presenceTtlMs: 60_000,
      rateLimits: {},
      guardTimeoutMs: 200,
      emergency: { stageSource: 'Stage', safeScene: 'Safe', stopStream: false },
      unattendedGatesSatisfied: false,
    },
    obs: { ready: true, run: async () => ({ ok: true, results: [] }) },
    permissionsOf: (holder) => kernel?.permissionsOf(holder),
    watchdogConnected: () => true,
  });
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  kernel = new Kernel({
    clock,
    safety: core.kernelHooks(),
    quiesceTimeoutMs: 500,
    log: (event, fields) => logs.push({ event, fields }),
  });
  kernel.provideScoped(SafetyService, ({ instanceId }) => safetyFacade(core, instanceId));
  kernel.provideCore(ClockService, clock);
  kernel.provideCore(ObsConnectorService, { connect: () => ObsClient.connect(obs.url, undefined) });

  // 代表发声仲裁：取得 Stage 音频输出许可后经 Stage 服务播放。
  let speaker: { play(samples: number): Promise<PlaybackResult> } | undefined;
  const speakerPlugin = definePlugin({
    manifest: {
      id: 'test-speaker',
      version: '1.0.0',
      tier: 'ordinary',
      provides: [],
      inject: [SafetyService.ref, StageService.ref],
      permissions: [],
      process: 'in-process',
      config: Type.Object({}),
    },
    activate(ctx) {
      const safety = ctx.service(SafetyService);
      const stage: Stage = ctx.service(StageService);
      let n = 0;
      speaker = {
        async play(samples) {
          const granted = safety.grant(STAGE_AUDIO);
          if (!granted.ok) throw new Error(granted.reason);
          n += 1;
          const pcm = new Int16Array(samples).map((_, i) => i % 100);
          async function* audio() {
            yield pcm.subarray(0, samples / 2);
            yield pcm.subarray(samples / 2);
          }
          return stage.play(
            {
              id: `s${n}`,
              subtitle: '你好',
              sampleRate: 24_000,
              subtitleStarts: () => [0, samples / 2],
            },
            audio(),
            granted.lease.token,
          );
        },
      };
    },
  });
  kernel.add(
    [
      entry('obs', 'obs-control', ['obs.control']),
      entry('stage-page', 'stage-page-obs', [STAGE_URL], {
        redistributeMinMs: 200,
        resumeWindowMs: 400,
        helloTimeoutMs: 500,
        idleTimeoutMs: 1000,
        ...pageConfig,
      }),
      entry('stage', 'stage-service', [], { heartbeatMs: 100, pageTimeoutMs: 2000 }),
      entry('speaker', 'test-speaker', ['speech.output']),
    ],
    catalog(obsControl, obsStagePage, stageService, speakerPlugin),
  );
  await kernel.settled();
  const active = kernel;

  const url = () => String(obs.inputSettings.get('Stage')?.url ?? '');
  await until(() => url() !== '');
  const parsed = new URL(url());
  return {
    logs,
    core,
    obs,
    store,
    kernel: active,
    port: Number(parsed.port),
    host: parsed.host,
    origin: parsed.origin,
    url,
    token: () => new URL(url()).hash.slice(3),
    speaker: () => {
      if (!speaker) throw new Error('发声插件未激活');
      return speaker;
    },
    async close() {
      await active.shutdown();
      store.close();
      await obs.close();
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    },
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function get(s: Setup, path: string, headers: Record<string, string>) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
    (done, fail) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: s.port, path, headers, setHost: false },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            done({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('error', fail);
      req.end();
    },
  );
}

/** 模拟页面：建立 WebSocket 并发出首条消息，返回结果与连接。 */
function attempt(
  s: Setup,
  first: object | null,
  headers: Record<string, string> = { origin: s.origin },
  path = '/stage',
): Promise<{ result: string; ws?: WebSocket; messages: unknown[]; binary: Buffer[] }> {
  return new Promise((done) => {
    const messages: unknown[] = [];
    const binary: Buffer[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}${path}`, { headers });
    ws.on('unexpected-response', (_req, res) =>
      done({ result: `http-${res.statusCode}`, messages, binary }),
    );
    ws.on('error', () => done({ result: 'error', messages, binary }));
    ws.on('open', () => {
      if (first) ws.send(JSON.stringify(first));
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        binary.push(data as Buffer);
        return;
      }
      const message = JSON.parse(String(data)) as { kind: string };
      messages.push(message);
      if (message.kind === 'welcome') done({ result: 'welcome', ws, messages, binary });
    });
    ws.on('close', (code) => done({ result: `close-${code}`, messages, binary }));
  });
}

const hello = (token: string) => ({
  kind: 'hello',
  token,
  obs: '2.26.2',
  userAgent: 'test',
  sampleRate: 48_000,
});

test('Host 与 Origin：只放行本端地址；缺 Origin 只放行页面文档的顶层导航', async () => {
  const s = await setup();
  try {
    const navigate = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    assert.equal((await get(s, '/', { host: s.host, ...navigate })).status, 200);
    assert.equal((await get(s, '/', { host: 'localhost', ...navigate })).status, 403);
    assert.equal((await get(s, '/', { host: s.host })).status, 403);
    const iframe = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' };
    assert.equal((await get(s, '/', { host: s.host, ...iframe })).status, 403);
    assert.equal((await get(s, '/page.js', { host: s.host, ...navigate })).status, 403);
    assert.equal((await get(s, '/page.js', { host: s.host, origin: s.origin })).status, 200);
    assert.equal((await get(s, '/subtitle.js', { host: s.host, origin: s.origin })).status, 200);
    assert.equal(
      (await get(s, '/worklet.js', { host: s.host, origin: 'http://evil' })).status,
      403,
    );
    assert.equal((await get(s, '/nope', { host: s.host, origin: s.origin })).status, 404);
    const page = await get(s, '/', { host: s.host, ...navigate });
    assert.match(String(page.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.match(String(page.headers['content-security-policy']), /style-src 'self';/);
    // 样式表带 crossorigin（请求才带 Origin）；字幕两段的样式都在样式表里，没有被 CSP 拦下的内联样式。
    assert.match(
      page.body,
      /<link rel="stylesheet" href="\/stage.css" crossorigin="anonymous" \/>/,
    );
    assert.match(
      page.body,
      /<span id="subtitle-shown"><\/span><span id="subtitle-hidden"><\/span>/,
    );
    assert.doesNotMatch(page.body, /\sstyle=|<style/);
    const css = await get(s, '/stage.css', { host: s.host, origin: s.origin });
    assert.equal(css.status, 200);
    assert.match(css.body, /#subtitle-hidden \{\s*visibility: hidden;\s*\}/);

    const token = s.token();
    assert.equal((await attempt(s, hello(token), {})).result, 'http-403');
    assert.equal((await attempt(s, hello(token), { origin: 'http://evil' })).result, 'http-403');
    assert.equal(
      (await attempt(s, hello(token), { origin: s.origin, host: 'localhost' })).result,
      'http-403',
    );
    assert.equal(
      (await attempt(s, hello(token), { origin: s.origin }, '/other')).result,
      'http-403',
    );
    // 以上都没有消耗令牌。
    const ok = await attempt(s, hello(token));
    assert.equal(ok.result, 'welcome');
    ok.ws?.close();
  } finally {
    await s.close();
  }
});

test('令牌：错误与重放都被拒并限频重新下发；同时只允许一个会话；会话密钥只在时限内能重连', async () => {
  const s = await setup();
  try {
    const first = s.token();
    // 刷新后没有令牌的页面同样被拒，并触发重新下发。
    assert.equal((await attempt(s, { ...hello(''), token: null })).result, 'close-4401');
    await until(() => s.token() !== first);
    const second = s.token();
    assert.equal((await attempt(s, hello('A'.repeat(22)))).result, 'close-4401');
    // 被拒后重新下发了新令牌，旧令牌随之作废。
    await until(() => s.token() !== second);
    assert.equal((await attempt(s, hello(second))).result, 'close-4401');

    const token = s.token();
    const page = await attempt(s, hello(token));
    assert.equal(page.result, 'welcome');
    const { sessionKey } = page.messages[0] as { sessionKey: string };
    assert.equal(
      s.store.events().filter((e) => e.type === 'stage.connected').length,
      1,
      '握手记下 OBS 与浏览器内核的版本',
    );
    assert.equal((await attempt(s, hello(token))).result, 'http-409');

    page.ws?.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // 刷新后重放用过的令牌：被拒。
    assert.equal((await attempt(s, hello(token))).result, 'close-4401');
    // 内存里的会话密钥能重连。
    const resumed = await attempt(s, { kind: 'resume', sessionKey });
    assert.equal(resumed.result, 'welcome');
    resumed.ws?.close();
    // 超过重连时限后会话密钥作废，宿主重新下发 URL。
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal((await attempt(s, { kind: 'resume', sessionKey })).result, 'close-4401');
    await until(() => s.token() !== token);
  } finally {
    await s.close();
  }
});

test('会话断开后令牌又被拒：按最小间隔重新下发，不等到重连时限', async () => {
  const s = await setup({ redistributeMinMs: 1000, resumeWindowMs: 10_000 });
  try {
    const token = s.token();
    const page = await attempt(s, hello(token));
    assert.equal(page.result, 'welcome');
    // 会话断开：按重连时限（10 秒）排了一次重新下发。
    page.ws?.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // 距上次下发不到最小间隔时重放用过的令牌（OBS 重建浏览器后页面会这样）：被拒，按最小间隔重新下发。
    const rejectedAt = Date.now();
    assert.equal((await attempt(s, hello(token))).result, 'close-4401');
    await until(() => s.token() !== token, 4000);
    assert.ok(Date.now() - rejectedAt < 4000);
  } finally {
    await s.close();
  }
});

test('首条消息超时或不合法、认证后发来不合法的消息，都断开连接', async () => {
  const s = await setup();
  try {
    assert.equal((await attempt(s, null)).result, 'close-4408');
    assert.equal((await attempt(s, { kind: 'hello' })).result, 'close-4401');
    const page = await attempt(s, hello(s.token()));
    assert.equal(page.result, 'welcome');
    const closed = new Promise<number>((done) => page.ws?.on('close', (code) => done(code)));
    page.ws?.send(JSON.stringify({ kind: 'ended', sentenceId: 'x', played: -1 }));
    assert.equal(await closed, 1006);
  } finally {
    await s.close();
  }
});

test('缺省 URL 只带令牌（interactive）、不收 stats；改用 playback 与打开诊断后片段带上它们，stats 只记日志', async () => {
  const stats = {
    kind: 'stats',
    latencyHint: 'interactive',
    sampleRate: 48_000,
    baseLatency: 0.01,
    outputLatency: 0,
    currentTime: 1.5,
    outputContextTime: 1.42,
    outputPerformanceTime: 1234.5,
    performanceNow: 1230.1,
  };
  const plain = await setup();
  try {
    assert.match(new URL(plain.url()).hash, /^#t=[A-Za-z0-9_-]{22}$/);
    const page = await attempt(plain, hello(plain.token()));
    assert.equal(page.result, 'welcome');
    const closed = new Promise<number>((done) => page.ws?.on('close', (code) => done(code)));
    page.ws?.send(JSON.stringify(stats));
    assert.equal(await closed, 1006);
  } finally {
    await plain.close();
  }
  const s = await setup({ latencyHint: 'playback', statsEveryMs: 500 });
  try {
    const fragment = new URLSearchParams(new URL(s.url()).hash.slice(1));
    assert.equal(fragment.get('l'), 'playback');
    assert.equal(fragment.get('s'), '500');
    const page = await attempt(s, hello(fragment.get('t') as string));
    assert.equal(page.result, 'welcome');
    page.ws?.send(JSON.stringify(stats));
    await until(() => s.logs.some((l) => l.event === 'stage-page.stats'));
    const logged = s.logs.find((l) => l.event === 'stage-page.stats')?.fields ?? {};
    assert.equal(logged.latencyHint, 'interactive');
    assert.equal(logged.outputContextTime, 1.42);
    assert.equal(logged.kind, undefined);
    // 不合格的 stats 与其它不合格的消息一样断开。
    const closed = new Promise<number>((done) => page.ws?.on('close', (code) => done(code)));
    page.ws?.send(JSON.stringify({ ...stats, latencyHint: 'fast' }));
    assert.equal(await closed, 1006);
  } finally {
    await s.close();
  }
});

test('认证后的页面收到心跳、令牌、句子与带头的二进制音频；回报决定播放结果', async () => {
  const s = await setup();
  try {
    const page = await attempt(s, hello(s.token()));
    assert.equal(page.result, 'welcome');
    const ws = page.ws as WebSocket;
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(String(data)) as { kind: string; sentenceId?: string };
      if (message.kind === 'heartbeat') ws.send(JSON.stringify({ kind: 'heartbeat-ack' }));
      if (message.kind === 'end') {
        const id = message.sentenceId as string;
        ws.send(JSON.stringify({ kind: 'started', sentenceId: id }));
        ws.send(JSON.stringify({ kind: 'ended', sentenceId: id, played: 480 }));
      }
    });
    await until(() => page.messages.some((m) => (m as { kind: string }).kind === 'heartbeat'));
    assert.ok(s.core.requestMode('M1').ok);
    const result = await s.speaker().play(480);
    assert.deepEqual(result, { sentenceId: 's1', played: 480, complete: true });

    const kinds = page.messages.map((m) => (m as { kind: string }).kind);
    assert.ok(kinds.includes('token'));
    assert.ok(kinds.includes('begin'));
    const begin = page.messages.find((m) => (m as { kind: string }).kind === 'begin');
    assert.deepEqual(
      { ...(begin as object), token: 0 },
      { kind: 'begin', sentenceId: 's1', token: 0, subtitle: '你好', sampleRate: 24_000 },
    );
    // 字幕映射以文本消息送达，带同一令牌；没有变化不重发。
    const timing = page.messages.filter((m) => (m as { kind: string }).kind === 'timing');
    assert.deepEqual(timing, [
      {
        kind: 'timing',
        sentenceId: 's1',
        token: (begin as { token: number }).token,
        starts: [0, 240],
      },
    ]);
    const frames = page.binary.map((buffer) => {
      const copy = new Uint8Array(buffer).slice().buffer;
      return decodeAudio(copy);
    });
    assert.equal(frames.length, 2);
    assert.equal(frames[0]?.header.sentenceId, 's1');
    assert.equal(frames[0]?.pcm.length, 240);
    assert.equal(frames[1]?.pcm[5], 245 % 100);
    ws.close();
  } finally {
    await s.close();
  }
});

test('页面回报播完但采样数少于已转发的：按未完整播出处理，played 取页面回报的数', async () => {
  const s = await setup();
  try {
    const page = await attempt(s, hello(s.token()));
    assert.equal(page.result, 'welcome');
    const ws = page.ws as WebSocket;
    /** 每句回报的“播完”采样数：第一句只收到一半，第二句一点都没收到。 */
    const reported = [240, 0, 480];
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(String(data)) as { kind: string; sentenceId?: string };
      if (message.kind === 'heartbeat') ws.send(JSON.stringify({ kind: 'heartbeat-ack' }));
      if (message.kind === 'end') {
        const played = reported.shift() ?? 0;
        ws.send(JSON.stringify({ kind: 'ended', sentenceId: message.sentenceId, played }));
      }
    });
    await until(() => page.messages.some((m) => (m as { kind: string }).kind === 'heartbeat'));
    assert.ok(s.core.requestMode('M1').ok);
    assert.deepEqual(await s.speaker().play(480), {
      sentenceId: 's1',
      played: 240,
      complete: false,
      reason: '页面回报播完，但只播出已转发的 240/480 个采样',
    });
    assert.deepEqual(await s.speaker().play(480), {
      sentenceId: 's2',
      played: 0,
      complete: false,
      reason: '页面回报播完，但只播出已转发的 0/480 个采样',
    });
    // 收到的都播了：照常算完整。
    assert.deepEqual(await s.speaker().play(480), {
      sentenceId: 's3',
      played: 480,
      complete: true,
    });
    ws.close();
  } finally {
    await s.close();
  }
});

test('页面未连接：安全停止下 Stage 服务只是未就绪、不判失败；开始一句时立即以未连接截断', async () => {
  const s = await setup();
  try {
    // 超过 Stage 服务的页面超时（2000ms）仍保持激活。
    await new Promise((resolve) => setTimeout(resolve, 2300));
    assert.equal(s.kernel.snapshot().find((e) => e.id === 'stage')?.state, 'active');
    assert.ok(s.core.requestMode('M1').ok);
    const result = await s.speaker().play(480);
    assert.equal(result.complete, false);
    assert.equal(result.reason, 'Stage 页面未连接');
  } finally {
    await s.close();
  }
});
