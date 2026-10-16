/**
 * 探针 S-01：OBS 32.2.x 浏览器源中的 Stage 页面（见 docs/plan/spikes.md 与 R-08、R-09）。
 *
 *   node spikes/s01-stage/server.ts --negative
 *     不需要 OBS：用本机客户端验证错误的 Host、错误或缺少的 Origin、错误与重放的令牌、第二个会话都被拒绝。
 *
 *   node spikes/s01-stage/server.ts [--minutes N] [--obs-source 名字] [--stop-heartbeat-after 秒] [--strict-origin]
 *     在 127.0.0.1 的随机端口提供探针页面，持续送出 440Hz 正弦 PCM，记录页面自检、请求头、游标、欠载与心跳。
 *     --obs-source           用 SecretStore 中的 obs 凭据，把带一次性令牌的 URL 写进这个已有的浏览器源
 *                            （只改 URL，并读回它的设置核对“Control audio via OBS”等）；不给时只打印 URL。
 *     --stop-heartbeat-after 从第 N 秒起停发心跳、继续送音频，检验页面按已渲染样本帧自静音。
 *     --strict-origin        按 R-08 字面要求，所有请求缺少 Origin 都拒绝（缺省只放行顶层文档导航）。
 *
 * 浏览器对顶层导航的 GET 通常不带 Origin，所以探针记录每个请求实际带的头，供判断 R-08 的校验能否照字面执行。
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  readonly token = randomBytes(16).toString('base64url');
  readonly requests: RequestRecord[] = [];
  readonly strictOrigin: boolean;
  onSession: ((ws: WebSocket, hello: PageMessage) => void) | undefined;
  #server: Server | undefined;
  #wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
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
      if (hello?.type !== 'hello' || hello.token !== this.token || this.#tokenUsed) {
        ws.close(4401, 'token rejected');
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

async function pointObsAt(sourceName: string, url: string) {
  const secret = await readObsSecret(new KeyringSecretStore('bellis'), OBS_SECRET);
  const obs = await ObsClient.connect(secret.url, secret.password);
  try {
    const ok = (result: ObsResult) => {
      if (!result.ok)
        throw new Error(`${result.requestType} 失败：${result.code} ${result.comment ?? ''}`);
      return result.data ?? {};
    };
    const version = ok(await obs.request('GetVersion'));
    ok(await obs.request('SetInputSettings', { inputName: sourceName, inputSettings: { url } }));
    const settings = ok(await obs.request('GetInputSettings', { inputName: sourceName }));
    // 读回的设置里有带令牌的 URL，记录前去掉。
    const { url: _url, ...rest } = (settings.inputSettings ?? {}) as Record<string, unknown>;
    return { version, inputKind: settings.inputKind, inputSettings: rest };
  } finally {
    obs.close();
  }
}

async function play(options: {
  minutes: number;
  obsSource: string | undefined;
  stopHeartbeatAfter: number | undefined;
  strictOrigin: boolean;
  log: (entry: Record<string, unknown>) => void;
}) {
  const server = new ProbeServer({ strictOrigin: options.strictOrigin });
  await server.start();
  const result: Record<string, unknown> = { strictOrigin: options.strictOrigin };
  const cursors: Array<{ t: number; rendered: number }> = [];
  const ackDelays: number[] = [];
  const events: PageMessage[] = [];
  let last: PageMessage | undefined;
  const finished = new Promise<void>((done) => {
    server.onSession = (ws, hello) => {
      result.selfCheck = hello.selfCheck;
      options.log({ t: performance.now(), type: 'session', selfCheck: hello.selfCheck });
      const sampleRate = Number((hello.selfCheck as { sampleRate?: number }).sampleRate ?? 48000);
      const chunk = Math.round(sampleRate * CHUNK_SECONDS);
      const started = performance.now();
      let sent = 0;
      let consumed = 0;
      let seq = 0;
      const hbSent = new Map<number, number>();
      const pump = setInterval(() => {
        while (sent - consumed < sampleRate * AHEAD_SECONDS) {
          const samples = new Float32Array(chunk);
          for (let i = 0; i < chunk; i++) {
            samples[i] = 0.2 * Math.sin((2 * Math.PI * TONE_HZ * (sent + i)) / sampleRate);
          }
          ws.send(samples.buffer);
          sent += chunk;
        }
      }, CHUNK_SECONDS * 1000);
      const heartbeat = setInterval(() => {
        const elapsed = (performance.now() - started) / 1000;
        if (options.stopHeartbeatAfter !== undefined && elapsed >= options.stopHeartbeatAfter) {
          if (!result.heartbeatStoppedAt) {
            result.heartbeatStoppedAt = performance.now() - started;
            result.lastCursorBeforeStop = last;
            options.log({ t: performance.now(), type: 'heartbeat-stopped' });
          }
          return;
        }
        hbSent.set(++seq, performance.now());
        ws.send(JSON.stringify({ type: 'hb', seq }));
      }, HEARTBEAT_MS);
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(String(data)) as PageMessage;
        const t = performance.now();
        options.log({ t, ...message });
        if (message.type === 'cursor') {
          last = message;
          consumed = Number(message.played) + Number(message.dropped);
          cursors.push({ t, rendered: Number(message.rendered) });
        } else if (message.type === 'hb-ack') {
          const at = hbSent.get(Number(message.seq));
          if (at !== undefined) ackDelays.push(t - at);
        } else {
          events.push({ ...message, serverT: t - started });
        }
      });
      const stop = () => {
        clearInterval(pump);
        clearInterval(heartbeat);
        done();
      };
      ws.on('close', (code) => {
        result.closedBy = `page ${code}`;
        stop();
      });
      setTimeout(stop, options.minutes * 60_000);
    };
  });
  console.log(`探针页面：${server.url}`);
  if (options.obsSource) {
    result.obs = await pointObsAt(options.obsSource, server.url);
    console.log(`已把 URL 写进浏览器源「${options.obsSource}」`);
  } else {
    console.log('请把上面的 URL 填进 OBS 浏览器源（开启“Control audio via OBS”）。');
  }
  await finished;
  await server.close();

  result.requests = server.requests;
  result.lastCursor = last;
  result.events = events;
  result.heartbeatAckMs = summarize(ackDelays);
  const first = cursors[0];
  const end = cursors.at(-1);
  const sampleRate = Number((result.selfCheck as { sampleRate?: number } | undefined)?.sampleRate);
  if (first && end && end.t > first.t && sampleRate) {
    const audioSeconds = (end.rendered - first.rendered) / sampleRate;
    const wallSeconds = (end.t - first.t) / 1000;
    result.clock = {
      audioSeconds,
      wallSeconds,
      driftPpm: Math.round((audioSeconds / wallSeconds - 1) * 1e6),
    };
  }
  return result;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      negative: { type: 'boolean', default: false },
      minutes: { type: 'string', default: '1' },
      'obs-source': { type: 'string' },
      'stop-heartbeat-after': { type: 'string' },
      'strict-origin': { type: 'boolean', default: false },
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
    const lines: string[] = [];
    report.play = await play({
      minutes: Number(values.minutes),
      obsSource: values['obs-source'],
      stopHeartbeatAfter:
        values['stop-heartbeat-after'] === undefined
          ? undefined
          : Number(values['stop-heartbeat-after']),
      strictOrigin: values['strict-origin'],
      log: (entry) => lines.push(JSON.stringify(entry)),
    });
    writeFileSync(`${out}.jsonl`, `${lines.join('\n')}\n`);
  }
  report.finished = new Date().toISOString();
  writeFileSync(`${out}.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`结果已写入 ${out}.json`);
}

await main();
