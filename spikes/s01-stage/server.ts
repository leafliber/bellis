/**
 * 探针 S-01：OBS 32.2.x 浏览器源中的 Stage 页面（见 docs/plan/spikes.md 与 R-08、R-09）。
 *
 *   node spikes/s01-stage/server.ts --negative
 *     不需要 OBS：用本机客户端验证错误的 Host、错误或缺少的 Origin、错误与重放的令牌、第二个会话都被拒绝。
 *
 *   node spikes/s01-stage/server.ts [--minutes N] [--obs-source 名字] [--stop-heartbeat-after 秒] [--strict-origin]
 *     在 127.0.0.1 的随机端口提供探针页面，持续送出 440Hz 正弦 PCM，记录页面自检、请求头、游标、欠载与心跳。
 *     --obs-source           用 SecretStore 中的 obs 凭据，把带一次性令牌的 URL 写进这个已有的浏览器源，
 *                            同时按 Stage 文档设好“Control audio via OBS”等，并读回核对；不给时只打印 URL。
 *     --stop-heartbeat-after 从第 N 秒起停发心跳、继续送音频，检验页面按已渲染样本帧自静音。
 *     --strict-origin        按 R-08 字面要求，所有请求缺少 Origin 都拒绝（缺省只放行顶层文档导航）。
 *     --record               全程让 OBS 录制，结束后用 ffmpeg 分析录音（断流、异常峰值、音高）；录制文件保留在 OBS 的录制目录。
 *     --hide-at、--show-at、--stop-heartbeat-after、--resume-heartbeat-at、--refresh-at：时间线动作，见 PlayOptions。
 *     --burst-seconds、--gap-seconds [--gap-fill-db]：按句播出（测试音与静默交替），录音按句段分析，见 PlayOptions。
 *     结束时把浏览器源的设置（含 URL）写回开始时的样子。
 *
 * 浏览器对顶层导航的 GET 通常不带 Origin，所以探针记录每个请求实际带的头，供判断 R-08 的校验能否照字面执行。
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { OBS_SECRET, readObsSecret } from '@bellis/config';
import { ObsClient, type ObsResult } from '@bellis/obs';
import { KeyringSecretStore } from '@bellis/secret-store';
import { WebSocket, WebSocketServer } from 'ws';
import { analyzeRecording, analyzeSegments } from './analyze-recording.ts';
import { ObsMeters } from './meters.ts';

const PAGE_DIR = fileURLToPath(new URL('./page/', import.meta.url));
const STATIC: Record<string, [file: string, type: string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/page.js': ['page.js', 'text/javascript; charset=utf-8'],
  '/worklet.js': ['worklet.js', 'text/javascript; charset=utf-8'],
};
const MAX_MESSAGE_BYTES = 64 * 1024;
const HELLO_TIMEOUT_MS = 2000;
const HEARTBEAT_MS = 250;
const TONE_HZ = 440;
const AHEAD_SECONDS = 0.5;
const CHUNK_SECONDS = 0.02;

interface RequestRecord {
  t: number;
  kind: 'request' | 'upgrade';
  method: string | undefined;
  url: string | undefined;
  host: string | undefined;
  origin: string | undefined;
  secFetchMode: string | undefined;
  secFetchDest: string | undefined;
  secFetchSite: string | undefined;
  decision: string;
}

type PageMessage = { type: string; [field: string]: unknown };

class ProbeServer {
  readonly requests: RequestRecord[] = [];
  readonly strictOrigin: boolean;
  onSession: ((ws: WebSocket, hello: PageMessage) => void) | undefined;
  onHelloRejected: (() => void) | undefined;
  #server: Server | undefined;
  #wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  #token = randomBytes(16).toString('base64url');
  #tokenUsed = false;
  #session: WebSocket | undefined;
  #port = 0;

  constructor(options: { strictOrigin: boolean }) {
    this.strictOrigin = options.strictOrigin;
  }

  get host(): string {
    return `127.0.0.1:${this.#port}`;
  }

  get origin(): string {
    return `http://${this.host}`;
  }

  get url(): string {
    return `${this.origin}/#t=${this.token}`;
  }

  get port(): number {
    return this.#port;
  }

  get token(): string {
    return this.#token;
  }

  /** 重新下发：换一个新的一次性令牌，旧令牌作废。 */
  rotateToken(): void {
    this.#token = randomBytes(16).toString('base64url');
    this.#tokenUsed = false;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => this.#onRequest(req, res));
    server.on('upgrade', (req, socket, head) => this.#onUpgrade(req, socket, head));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    this.#port = (server.address() as AddressInfo).port;
    this.#server = server;
  }

  async close(): Promise<void> {
    this.#session?.close(1001, 'probe finished');
    for (const client of this.#wss.clients) client.terminate();
    await new Promise<void>((done) => this.#server?.close(() => done()) ?? done());
  }

  /** 返回拒绝原因；undefined 表示放行。 */
  #check(req: IncomingMessage, kind: RequestRecord['kind']): string | undefined {
    if (req.headers.host !== this.host) return 'host';
    const origin = req.headers.origin;
    if (origin === undefined) {
      const navigation =
        kind === 'request' &&
        req.headers['sec-fetch-mode'] === 'navigate' &&
        req.headers['sec-fetch-dest'] === 'document';
      return this.strictOrigin || !navigation ? 'origin-missing' : undefined;
    }
    return origin === this.origin ? undefined : 'origin';
  }

  #record(req: IncomingMessage, kind: RequestRecord['kind'], decision: string): void {
    const header = (name: string) => {
      const value = req.headers[name];
      return Array.isArray(value) ? value.join(',') : value;
    };
    this.requests.push({
      t: performance.now(),
      kind,
      method: req.method,
      url: req.url,
      host: header('host'),
      origin: header('origin'),
      secFetchMode: header('sec-fetch-mode'),
      secFetchDest: header('sec-fetch-dest'),
      secFetchSite: header('sec-fetch-site'),
      decision,
    });
  }

  #onRequest(req: IncomingMessage, res: ServerResponse): void {
    const reason = this.#check(req, 'request');
    const entry = STATIC[(req.url ?? '').split('?')[0] ?? ''];
    const decision = reason ?? (entry && req.method === 'GET' ? 'ok' : 'not-found');
    this.#record(req, 'request', decision);
    if (decision !== 'ok' || !entry) {
      res.writeHead(reason ? 403 : 404).end();
      return;
    }
    res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-store' });
    res.end(readFileSync(join(PAGE_DIR, entry[0])));
  }

  #onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const reason =
      req.url !== '/stage'
        ? 'path'
        : (this.#check(req, 'upgrade') ?? (this.#session ? 'session-active' : undefined));
    this.#record(req, 'upgrade', reason ?? 'ok');
    if (reason) {
      const status = reason === 'session-active' ? '409 Conflict' : '403 Forbidden';
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#onConnection(ws));
  }

  #onConnection(ws: WebSocket): void {
    // 认证完成前也占住会话位，防止并发的第二个连接趁机通过。
    this.#session = ws;
    const timer = setTimeout(() => ws.close(4408, 'hello timeout'), HELLO_TIMEOUT_MS);
    ws.on('close', () => {
      clearTimeout(timer);
      if (this.#session === ws) this.#session = undefined;
    });
    ws.once('message', (data, isBinary) => {
      clearTimeout(timer);
      let hello: PageMessage | undefined;
      try {
        hello = isBinary ? undefined : (JSON.parse(String(data)) as PageMessage);
      } catch {
        hello = undefined;
      }
      if (hello?.type !== 'hello' || hello.token !== this.#token || this.#tokenUsed) {
        ws.close(4401, 'token rejected');
        this.onHelloRejected?.();
        return;
      }
      this.#tokenUsed = true;
      ws.send(JSON.stringify({ type: 'welcome' }));
      this.onSession?.(ws, hello);
    });
  }
}

// ---------- 拒绝测试 ----------

interface Check {
  name: string;
  expected: string;
  actual: string;
  pass: boolean;
}

function httpGet(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((done, fail) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers, setHost: false }, (res) => {
      res.resume();
      done(res.statusCode ?? 0);
    });
    req.on('error', fail);
    req.end();
  });
}

/** 尝试建立会话：返回 HTTP 拒绝码、关闭码，或 welcome（成功时保持连接，由调用方关闭）。 */
function wsAttempt(
  port: number,
  headers: Record<string, string>,
  token: string | null,
): Promise<{ result: string; ws?: WebSocket }> {
  return new Promise((done) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/stage`, { headers });
    ws.on('unexpected-response', (_req, res) => done({ result: `http-${res.statusCode}` }));
    ws.on('error', () => done({ result: 'error' }));
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token })));
    ws.on('message', (data) => {
      if (JSON.parse(String(data)).type === 'welcome') done({ result: 'welcome', ws });
    });
    ws.on('close', (code) => done({ result: `close-${code}` }));
  });
}

async function negative(): Promise<Check[]> {
  const checks: Check[] = [];
  const expect = (name: string, expected: string, actual: string) => {
    checks.push({ name, expected, actual, pass: expected === actual });
  };
  const server = new ProbeServer({ strictOrigin: false });
  await server.start();
  const { port, host, origin, token } = server;
  const navigate = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  try {
    expect(
      'Host 为 localhost',
      '403',
      String(await httpGet(port, '/', { host: `localhost:${port}`, ...navigate })),
    );
    expect(
      'DNS 重绑定的 Host',
      '403',
      String(await httpGet(port, '/', { host: `evil.example:${port}`, ...navigate })),
    );
    expect(
      '顶层文档导航不带 Origin（缺省策略放行）',
      '200',
      String(await httpGet(port, '/', { host, ...navigate })),
    );
    expect('子资源不带 Origin', '403', String(await httpGet(port, '/page.js', { host })));
    expect(
      '子资源 Origin 错误',
      '403',
      String(await httpGet(port, '/page.js', { host, origin: 'http://evil.example' })),
    );
    expect('子资源 Origin 正确', '200', String(await httpGet(port, '/page.js', { host, origin })));
    expect(
      '升级 Origin 错误',
      'http-403',
      (await wsAttempt(port, { origin: 'http://evil.example' }, token)).result,
    );
    expect('升级不带 Origin', 'http-403', (await wsAttempt(port, {}, token)).result);
    expect(
      '升级 Host 错误',
      'http-403',
      (await wsAttempt(port, { host: `evil.example:${port}`, origin }, token)).result,
    );
    expect('令牌错误', 'close-4401', (await wsAttempt(port, { origin }, 'wrong')).result);
    const first = await wsAttempt(port, { origin }, token);
    expect('令牌正确', 'welcome', first.result);
    expect('已有会话时的第二个会话', 'http-409', (await wsAttempt(port, { origin }, token)).result);
    first.ws?.close();
    await new Promise((wait) => setTimeout(wait, 100));
    expect(
      '会话结束后重放已用过的令牌',
      'close-4401',
      (await wsAttempt(port, { origin }, token)).result,
    );
  } finally {
    await server.close();
  }
  const strict = new ProbeServer({ strictOrigin: true });
  await strict.start();
  try {
    expect(
      '严格策略：顶层文档导航不带 Origin',
      '403',
      String(await httpGet(strict.port, '/', { host: strict.host, ...navigate })),
    );
  } finally {
    await strict.close();
  }
  return checks;
}

// ---------- OBS 中的播放 ----------

function summarize(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) ?? 0 };
}

function okData(result: ObsResult): Record<string, unknown> {
  if (!result.ok)
    throw new Error(`${result.requestType} 失败：${result.code} ${result.comment ?? ''}`);
  return result.data ?? {};
}

/** 按 Stage 文档设好浏览器源并写入 URL：声音只经 OBS，不可见时不关停、激活时不刷新，不授予页面任何 OBS 权限。 */
async function pointSourceAt(obs: ObsClient, sourceName: string, url: string) {
  okData(
    await obs.request('SetInputSettings', {
      inputName: sourceName,
      inputSettings: {
        url,
        reroute_audio: true,
        shutdown: false,
        restart_when_active: false,
        webpage_control_level: 0,
      },
    }),
  );
  const settings = okData(await obs.request('GetInputSettings', { inputName: sourceName }));
  // 读回的设置里有带令牌的 URL，记录前去掉。
  const { url: _url, ...rest } = (settings.inputSettings ?? {}) as Record<string, unknown>;
  return { inputKind: settings.inputKind, inputSettings: rest };
}

/** 找到包含该来源的第一个场景及其场景项编号。 */
async function findSceneItem(obs: ObsClient, sourceName: string) {
  const scenes = okData(await obs.request('GetSceneList')).scenes as Array<{ sceneName: string }>;
  for (const { sceneName } of scenes) {
    const found = await obs.request('GetSceneItemId', { sceneName, sourceName });
    if (found.ok) return { sceneName, sceneItemId: found.data?.sceneItemId as number };
  }
  throw new Error(`没有场景包含来源「${sourceName}」`);
}

interface PlayOptions {
  minutes: number;
  obsSource: string | undefined;
  strictOrigin: boolean;
  /** 以下都是从探针开始算起的秒数。 */
  stopHeartbeatAfter: number | undefined;
  resumeHeartbeatAt: number | undefined;
  hideAt: number | undefined;
  showAt: number | undefined;
  refreshAt: number | undefined;
  record: boolean;
  /**
   * 按句播出：每 burstSeconds 秒的测试音（每段从相位 0 起）之后静默 gapSeconds 秒。gapFillDb 给出时，
   * 静默期间填该电平（dBFS）的白噪声而不是数字静音，用来检验静默之后首句开头的缺失是否取决于页面是否“有声”。
   */
  burstSeconds: number | undefined;
  gapSeconds: number | undefined;
  gapFillDb: number | undefined;
  log: (entry: Record<string, unknown>) => void;
}

/** 第 n 个采样：连续测试音，或按句播出的测试音与静默（见 PlayOptions）。 */
function sampleSource(options: PlayOptions): (n: number, rate: number) => number {
  const { burstSeconds, gapSeconds } = options;
  if (burstSeconds === undefined || gapSeconds === undefined)
    return (n, rate) => 0.2 * Math.sin((2 * Math.PI * TONE_HZ * n) / rate);
  const fill = options.gapFillDb === undefined ? 0 : 10 ** (options.gapFillDb / 20);
  return (n, rate) => {
    const position = n % Math.round((burstSeconds + gapSeconds) * rate);
    if (position < burstSeconds * rate)
      return 0.2 * Math.sin((2 * Math.PI * TONE_HZ * position) / rate);
    return fill === 0 ? 0 : fill * (Math.random() * 2 - 1);
  };
}

interface Session {
  index: number;
  selfCheck: unknown;
  sampleRate: number;
  cursors: Array<{ t: number; rendered: number }>;
  last: PageMessage | undefined;
}

async function play(options: PlayOptions) {
  const server = new ProbeServer({ strictOrigin: options.strictOrigin });
  await server.start();
  const t0 = performance.now();
  const seconds = () => Math.round(performance.now() - t0) / 1000;
  const result: Record<string, unknown> = {
    options: { ...options, log: undefined },
  };
  const timeline: Array<Record<string, unknown>> = [];
  const note = (type: string, fields: Record<string, unknown> = {}) => {
    const entry = { s: seconds(), type, ...fields };
    timeline.push(entry);
    options.log({ t: performance.now(), ...entry });
    console.log(`${entry.s}s ${type} ${JSON.stringify(fields)}`);
  };
  const sessions: Session[] = [];
  const ackDelays: number[] = [];
  let heartbeatOn = true;
  const sampleAt = sampleSource(options);

  server.onHelloRejected = () => note('hello-rejected');
  server.onSession = (ws, hello) => {
    const selfCheck = hello.selfCheck as { sampleRate?: number };
    const session: Session = {
      index: sessions.length + 1,
      selfCheck,
      sampleRate: Number(selfCheck.sampleRate ?? 48000),
      cursors: [],
      last: undefined,
    };
    sessions.push(session);
    note('session-start', { session: session.index });
    const chunk = Math.round(session.sampleRate * CHUNK_SECONDS);
    let sent = 0;
    let consumed = 0;
    let seq = 0;
    const hbSent = new Map<number, number>();
    const pump = setInterval(() => {
      while (sent - consumed < session.sampleRate * AHEAD_SECONDS) {
        const samples = new Float32Array(chunk);
        for (let i = 0; i < chunk; i++) samples[i] = sampleAt(sent + i, session.sampleRate);
        ws.send(samples.buffer);
        sent += chunk;
      }
    }, CHUNK_SECONDS * 1000);
    const heartbeat = setInterval(() => {
      if (!heartbeatOn) return;
      hbSent.set(++seq, performance.now());
      ws.send(JSON.stringify({ type: 'hb', seq }));
    }, HEARTBEAT_MS);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(String(data)) as PageMessage;
      const t = performance.now();
      options.log({ t, session: session.index, ...message });
      if (message.type === 'cursor') {
        session.last = message;
        consumed = Number(message.played) + Number(message.dropped);
        session.cursors.push({ t, rendered: Number(message.rendered) });
      } else if (message.type === 'hb-ack') {
        const at = hbSent.get(Number(message.seq));
        if (at !== undefined) ackDelays.push(t - at);
      } else {
        note(`page-${message.type}`, {
          session: session.index,
          frame: message.frame,
          visibility: message.visibility,
        });
      }
    });
    ws.on('close', (code) => {
      clearInterval(pump);
      clearInterval(heartbeat);
      note('session-closed', { session: session.index, code });
    });
  };

  let obs: ObsClient | undefined;
  let meters: ObsMeters | undefined;
  let item: { sceneName: string; sceneItemId: number } | undefined;
  let hidden = false;
  /** 浏览器源原来的设置（含 URL），结束时整体写回。 */
  let originalSettings: Record<string, unknown> | undefined;
  /** 每个输入每一秒的峰值（dBFS）。 */
  const levels = new Map<string, number[]>();
  const source = options.obsSource;
  if (source) {
    const secret = await readObsSecret(new KeyringSecretStore('bellis'), OBS_SECRET);
    obs = await ObsClient.connect(secret.url, secret.password);
    result.obsVersion = okData(await obs.request('GetVersion')).obsVersion;
    meters = await ObsMeters.connect(secret.url, secret.password, (readings) => {
      const second = Math.floor((performance.now() - t0) / 1000);
      for (const reading of readings) {
        const series = levels.get(reading.name) ?? [];
        series[second] = Math.max(series[second] ?? -Infinity, reading.peakDb);
        levels.set(reading.name, series);
      }
    });
    item = await findSceneItem(obs, source);
    originalSettings = okData(await obs.request('GetInputSettings', { inputName: source }))
      .inputSettings as Record<string, unknown>;
    result.source = await pointSourceAt(obs, source, server.url);
    note('url-set');
    if (options.record) {
      if (okData(await obs.request('GetRecordStatus')).outputActive)
        throw new Error('OBS 已在录制，拒绝接管');
      okData(await obs.request('StartRecord'));
      note('record-started');
    }
  } else {
    console.log(`探针页面：${server.url}`);
    console.log('请把上面的 URL 填进 OBS 浏览器源（开启“Control audio via OBS”）。');
  }

  const setVisible = async (enabled: boolean) => {
    if (!obs || !item) throw new Error('隐藏与显示来源需要 --obs-source');
    okData(await obs.request('SetSceneItemEnabled', { ...item, sceneItemEnabled: enabled }));
    hidden = !enabled;
  };
  const actions: Array<[number | undefined, string, () => Promise<void>]> = [
    [
      options.stopHeartbeatAfter,
      'heartbeat-stopped',
      async () => {
        heartbeatOn = false;
      },
    ],
    [
      options.resumeHeartbeatAt,
      'heartbeat-resumed',
      async () => {
        heartbeatOn = true;
      },
    ],
    [options.hideAt, 'source-hidden', () => setVisible(false)],
    [options.showAt, 'source-shown', () => setVisible(true)],
    [
      options.refreshAt,
      'refresh-pressed',
      async () => {
        if (!obs || !source) throw new Error('刷新需要 --obs-source');
        // 刷新会让页面重放 OBS 设置里已用过的令牌；随后像宿主一样换新令牌重新下发 URL。
        okData(
          await obs.request('PressInputPropertiesButton', {
            inputName: source,
            propertyName: 'refreshnocache',
          }),
        );
        setTimeout(() => {
          server.rotateToken();
          void pointSourceAt(obs as ObsClient, source, server.url).then(
            () => note('url-reissued'),
            (error: Error) => note('action-failed', { error: error.message }),
          );
        }, 3000);
      },
    ],
  ];
  const timers = actions
    .filter(([at]) => at !== undefined)
    .map(([at, name, action]) =>
      setTimeout(
        () =>
          void action().then(
            () => note(name),
            (error: Error) => note('action-failed', { action: name, error: error.message }),
          ),
        (at as number) * 1000,
      ),
    );

  await new Promise((wait) => setTimeout(wait, options.minutes * 60_000));
  for (const timer of timers) clearTimeout(timer);
  let recordingPath: string | undefined;
  if (options.record && obs) {
    recordingPath = okData(await obs.request('StopRecord')).outputPath as string;
    note('record-stopped');
    // StopRecord 返回时 OBS 可能还在写文件末尾：等录制确实停下、文件大小稳定后再分析。
    for (let size = -1; ; ) {
      await new Promise((wait) => setTimeout(wait, 1000));
      const active = okData(await obs.request('GetRecordStatus')).outputActive;
      const now = statSync(recordingPath).size;
      if (!active && now === size) break;
      size = now;
    }
    note('record-finalized');
  }
  if (hidden) await setVisible(true).catch(() => {});
  if (obs && source && originalSettings) {
    const restored = await obs.request('SetInputSettings', {
      inputName: source,
      inputSettings: originalSettings,
      overlay: false,
    });
    result.sourceRestored = restored.ok;
  }
  meters?.close();
  obs?.close();
  await server.close();

  result.requests = server.requests;
  result.timeline = timeline;
  result.heartbeatAckMs = summarize(ackDelays);
  result.sessions = sessions.map((session) => {
    const first = session.cursors[0];
    const end = session.cursors.at(-1);
    const clock =
      first && end && end.t > first.t
        ? {
            audioSeconds: (end.rendered - first.rendered) / session.sampleRate,
            wallSeconds: (end.t - first.t) / 1000,
          }
        : undefined;
    return {
      index: session.index,
      selfCheck: session.selfCheck,
      last: session.last,
      clock: clock && {
        ...clock,
        driftPpm: Math.round((clock.audioSeconds / clock.wallSeconds - 1) * 1e6),
      },
    };
  });
  result.levels = Object.fromEntries(
    [...levels].map(([name, series]) => {
      const observed = series.filter((db) => db !== undefined);
      const audible = observed.filter((db) => db > -40);
      return [
        name,
        {
          seconds: observed.length,
          audibleSeconds: audible.length,
          maxDb: Math.max(...observed),
          perSecondDb: series.map((db) => (Number.isFinite(db) ? Math.round(db * 10) / 10 : null)),
        },
      ];
    }),
  );
  if (recordingPath) {
    // 录制开始于探针时间线上的 record-started，分析结果里的时刻都相对录制开头。
    result.recording =
      options.burstSeconds === undefined
        ? await analyzeRecording(recordingPath, TONE_HZ)
        : await analyzeSegments(recordingPath, {
            toneHz: TONE_HZ,
            expectedSeconds: options.burstSeconds,
            trailingEdge: true,
          });
  }
  return result;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      negative: { type: 'boolean', default: false },
      minutes: { type: 'string', default: '1' },
      'obs-source': { type: 'string' },
      'strict-origin': { type: 'boolean', default: false },
      'stop-heartbeat-after': { type: 'string' },
      'resume-heartbeat-at': { type: 'string' },
      'hide-at': { type: 'string' },
      'show-at': { type: 'string' },
      'refresh-at': { type: 'string' },
      record: { type: 'boolean', default: false },
      'burst-seconds': { type: 'string' },
      'gap-seconds': { type: 'string' },
      'gap-fill-db': { type: 'string' },
      out: { type: 'string' },
    },
  });
  const started = new Date().toISOString();
  const tag = values.negative ? 'negative' : `play-${started.replace(/[:.]/g, '-')}`;
  const out = resolve(values.out ?? join('reports', `S-01-${started.slice(0, 10)}-${tag}`));
  mkdirSync(resolve(out, '..'), { recursive: true });
  const report: Record<string, unknown> = {
    spike: 'S-01',
    started,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
  };
  if (values.negative) {
    const checks = await negative();
    report.checks = checks;
    for (const check of checks) {
      console.log(
        `${check.pass ? '通过' : '失败'}  ${check.name}：期望 ${check.expected}，实际 ${check.actual}`,
      );
    }
  } else {
    const number = (value: string | undefined) => (value === undefined ? undefined : Number(value));
    const lines: string[] = [];
    report.play = await play({
      minutes: Number(values.minutes),
      obsSource: values['obs-source'],
      strictOrigin: values['strict-origin'],
      stopHeartbeatAfter: number(values['stop-heartbeat-after']),
      resumeHeartbeatAt: number(values['resume-heartbeat-at']),
      hideAt: number(values['hide-at']),
      showAt: number(values['show-at']),
      refreshAt: number(values['refresh-at']),
      record: values.record,
      burstSeconds: number(values['burst-seconds']),
      gapSeconds: number(values['gap-seconds']),
      gapFillDb: number(values['gap-fill-db']),
      log: (entry) => lines.push(JSON.stringify(entry)),
    });
    writeFileSync(`${out}.jsonl`, `${lines.join('\n')}\n`);
  }
  report.finished = new Date().toISOString();
  writeFileSync(`${out}.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`结果已写入 ${out}.json`);
}

await main();
