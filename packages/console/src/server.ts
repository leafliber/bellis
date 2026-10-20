import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Type from 'typebox';
import { Compile } from 'typebox/compile';

/** 操作员动作的参数不合法：以 400 拒绝。 */
export class InvalidParams extends Error {
  constructor() {
    super('参数不合法');
    this.name = 'InvalidParams';
  }
}

/** 一个 `/api/*` 接口：已通过全部核对的请求才会调到这里。 */
export interface ConsoleRoute {
  method: 'GET' | 'POST';
  /** GET 时 body 为 undefined。参数不合法时抛 InvalidParams。 */
  run(body: unknown): unknown;
}

export interface ConsoleOptions {
  /** 路径（例如 `/api/status`）到接口；`/api/login`、`/api/session`、`/api/logout` 由服务自己处理。 */
  routes: Readonly<Record<string, ConsoleRoute>>;
  log(event: string, fields?: Record<string, unknown>): void;
  /** 墙钟（毫秒），缺省 Date.now；测试用来推进时间。 */
  now?(): number;
  /** 一次性登录令牌的有效期，缺省 60 秒。 */
  loginTtlMs?: number;
  /** 会话的绝对有效期，缺省 12 小时。 */
  sessionTtlMs?: number;
  /** 同时存在的会话上限，缺省 4；超出时作废最早的会话。 */
  maxSessions?: number;
  /** 请求体上限，缺省 4 KiB。 */
  maxBodyBytes?: number;
}

/** 交给命令行的一次性登录令牌。 */
export interface ConsoleLogin {
  url: string;
  token: string;
  expiresInMs: number;
}

interface Session {
  id: string;
  csrf: string;
  createdAt: number;
  expiresAt: number;
}

const COOKIE = 'bellis_console';
const CSRF_HEADER = 'x-bellis-csrf';
const MAX_LOGIN_TOKENS = 4;
const PAGE_DIR = new URL('../page/', import.meta.url);
const FILES: Record<string, [file: string, type: string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/console.js': ['console.js', 'text/javascript; charset=utf-8'],
  '/console.css': ['console.css', 'text/css; charset=utf-8'],
};

/** 每个响应都带的安全头。 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'x-frame-options': 'DENY',
};

const isLoginBody = Compile(
  Type.Object(
    { token: Type.String({ minLength: 1, maxLength: 256 }) },
    { additionalProperties: false },
  ),
);

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(',') : value;
}

/** 请求里所有名为 bellis_console 的 cookie 值（cookie 不按端口隔离，别的端口也可能写同名的）。 */
function cookieValues(req: IncomingMessage): string[] {
  const raw = header(req, 'cookie');
  if (!raw) return [];
  return raw.split(';').flatMap((part) => {
    const index = part.indexOf('=');
    if (index < 0 || part.slice(0, index).trim() !== COOKIE) return [];
    return [part.slice(index + 1).trim()];
  });
}

function isJson(contentType: string | undefined): boolean {
  return contentType?.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

class Refused extends Error {
  readonly status: number;
  readonly reason: string;

  constructor(status: number, reason: string) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

/**
 * 本机操作台的 HTTP 服务（R-20）：只监听 127.0.0.1 的随机端口，与 Stage 不同源。
 *
 * - 每个请求的 `Host` 都要严格等于 `127.0.0.1:端口`（防 DNS 重绑定）；带了 `Origin` 的必须同源，带了
 *   `Sec-Fetch-Site` 的必须是 same-origin（页面文档的顶层导航另可为 none）。
 * - 页面文档只在顶层导航（navigate + document）时可以不带 Origin；脚本与样式表必须带同源的 Origin。
 *   页面本身不含任何数据，不需要会话。
 * - `/api/*` 都要会话 cookie；POST 还要同源的 Origin、`Content-Type: application/json` 与会话绑定的
 *   `X-Bellis-CSRF`。登录只要同源的 Origin 与 JSON，凭一次性令牌换会话。
 * - 任何一项不符都拒绝，响应体为空，原因只写日志。令牌、会话与 CSRF 都用定长时间比较，只存在内存里。
 */
export class ConsoleServer {
  readonly #server: Server;
  readonly #options: ConsoleOptions;
  readonly #now: () => number;
  readonly #files: Map<string, { body: Buffer; type: string }>;
  readonly #loginTokens = new Map<string, number>();
  readonly #sessions = new Map<string, Session>();
  readonly #loginTtlMs: number;
  readonly #sessionTtlMs: number;
  readonly #maxSessions: number;
  readonly #maxBodyBytes: number;
  #host = '';
  #origin = '';

  private constructor(options: ConsoleOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#loginTtlMs = options.loginTtlMs ?? 60_000;
    this.#sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60_000;
    this.#maxSessions = options.maxSessions ?? 4;
    this.#maxBodyBytes = options.maxBodyBytes ?? 4096;
    this.#files = new Map(
      Object.entries(FILES).map(([path, [file, type]]) => [
        path,
        { body: readFileSync(new URL(file, PAGE_DIR)), type },
      ]),
    );
    this.#server = createServer((req, res) => {
      this.#handle(req, res).catch((error: unknown) => {
        this.#options.log('console.error', { error: (error as Error).message });
        if (res.headersSent) res.destroy();
        else this.#json(res, 500, { ok: false, reason: '内部错误' });
      });
    });
    this.#server.requestTimeout = 10_000;
    this.#server.headersTimeout = 5000;
  }

  static async start(options: ConsoleOptions): Promise<ConsoleServer> {
    const server = new ConsoleServer(options);
    await new Promise<void>((done, fail) => {
      server.#server.once('error', fail);
      server.#server.listen(0, '127.0.0.1', () => {
        server.#server.off('error', fail);
        done();
      });
    });
    const { port } = server.#server.address() as AddressInfo;
    server.#host = `127.0.0.1:${port}`;
    server.#origin = `http://${server.#host}`;
    options.log('console.listening', { port });
    return server;
  }

  get port(): number {
    return (this.#server.address() as AddressInfo).port;
  }

  /** 操作台页面的地址。 */
  get url(): string {
    return `${this.#origin}/`;
  }

  /** 当前有效的会话数。 */
  get sessions(): number {
    this.#purge();
    return this.#sessions.size;
  }

  /** 生成一次性登录令牌（256 位随机，base64url），只存在内存里，过期或用过即作废。 */
  issueLogin(): ConsoleLogin {
    this.#purge();
    while (this.#loginTokens.size >= MAX_LOGIN_TOKENS) {
      const oldest = this.#loginTokens.keys().next().value;
      if (oldest === undefined) break;
      this.#loginTokens.delete(oldest);
    }
    const token = randomBytes(32).toString('base64url');
    this.#loginTokens.set(token, this.#now() + this.#loginTtlMs);
    this.#options.log('console.login-issued', { expiresInMs: this.#loginTtlMs });
    return { url: this.url, token, expiresInMs: this.#loginTtlMs };
  }

  async close(): Promise<void> {
    this.#loginTokens.clear();
    this.#sessions.clear();
    const closed = new Promise<void>((done) => this.#server.close(() => done()));
    this.#server.closeAllConnections();
    await closed;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0] ?? '';
    try {
      await this.#serve(req, res, path);
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      this.#options.log('console.refused', { method: req.method, path, reason: error.reason });
      res.writeHead(error.status, { ...SECURITY_HEADERS, connection: 'close' }).end();
    }
  }

  async #serve(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (header(req, 'host') !== this.#host) throw new Refused(403, 'host');
    const origin = header(req, 'origin');
    if (origin !== undefined && origin !== this.#origin) throw new Refused(403, 'origin');
    const site = header(req, 'sec-fetch-site');

    const file = this.#files.get(path);
    if (file) {
      if (req.method !== 'GET') throw new Refused(405, 'method');
      const navigation =
        path === '/' &&
        header(req, 'sec-fetch-mode') === 'navigate' &&
        header(req, 'sec-fetch-dest') === 'document';
      if (origin === undefined && !navigation) throw new Refused(403, 'origin-missing');
      if (site !== undefined && site !== 'same-origin' && !(navigation && site === 'none'))
        throw new Refused(403, 'site');
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': file.type });
      res.end(file.body);
      return;
    }
    if (!path.startsWith('/api/')) throw new Refused(404, 'not-found');
    if (site !== undefined && site !== 'same-origin') throw new Refused(403, 'site');

    const builtin: Record<string, 'GET' | 'POST'> = {
      '/api/login': 'POST',
      '/api/session': 'GET',
      '/api/logout': 'POST',
    };
    const route = this.#options.routes[path];
    const method = builtin[path] ?? route?.method;
    if (method === undefined) throw new Refused(404, 'not-found');
    if (req.method !== method) throw new Refused(405, 'method');
    if (method === 'POST') {
      if (origin === undefined) throw new Refused(403, 'origin-missing');
      if (!isJson(header(req, 'content-type'))) throw new Refused(415, 'content-type');
    }
    if (path === '/api/login') {
      await this.#login(req, res);
      return;
    }
    const session = this.#session(req);
    if (!session) throw new Refused(401, 'session');
    if (method === 'POST') {
      const sent = header(req, CSRF_HEADER);
      if (sent === undefined || !same(sent, session.csrf)) throw new Refused(403, 'csrf');
    }
    const body = method === 'POST' ? await this.#readJson(req) : undefined;

    if (path === '/api/session') {
      this.#json(res, 200, {
        ok: true,
        csrf: session.csrf,
        expiresAt: new Date(session.expiresAt).toISOString(),
      });
      return;
    }
    if (path === '/api/logout') {
      this.#sessions.delete(session.id);
      this.#options.log('console.logout', { sessions: this.#sessions.size });
      this.#json(
        res,
        200,
        { ok: true },
        `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      );
      return;
    }
    let result: unknown;
    try {
      result = await (route as ConsoleRoute).run(body);
    } catch (error) {
      if (!(error instanceof InvalidParams)) throw error;
      this.#options.log('console.invalid-params', { path });
      this.#json(res, 400, { ok: false, reason: error.message });
      return;
    }
    this.#json(res, 200, result ?? null);
  }

  async #login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.#readJson(req);
    if (!isLoginBody.Check(body)) throw new Refused(400, 'login-body');
    this.#purge();
    let matched: string | undefined;
    for (const token of this.#loginTokens.keys()) {
      if (same(body.token, token)) matched = token;
    }
    if (matched === undefined) throw new Refused(403, 'login-token');
    // 用过即作废，无论随后会话能否建立。
    this.#loginTokens.delete(matched);
    const now = this.#now();
    while (this.#sessions.size >= this.#maxSessions) {
      const oldest = [...this.#sessions.values()].reduce((a, b) =>
        a.createdAt <= b.createdAt ? a : b,
      );
      this.#sessions.delete(oldest.id);
      this.#options.log('console.session-evicted', {});
    }
    const session: Session = {
      id: randomBytes(32).toString('base64url'),
      csrf: randomBytes(32).toString('base64url'),
      createdAt: now,
      expiresAt: now + this.#sessionTtlMs,
    };
    this.#sessions.set(session.id, session);
    this.#options.log('console.login', { sessions: this.#sessions.size });
    this.#json(
      res,
      200,
      { ok: true, csrf: session.csrf, expiresAt: new Date(session.expiresAt).toISOString() },
      `${COOKIE}=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(this.#sessionTtlMs / 1000)}`,
    );
  }

  /** 请求带的有效会话；比较用定长时间，过期的会话随即作废。 */
  #session(req: IncomingMessage): Session | undefined {
    this.#purge();
    const values = cookieValues(req);
    let found: Session | undefined;
    for (const session of this.#sessions.values()) {
      for (const value of values) {
        if (same(value, session.id)) found = session;
      }
    }
    return found;
  }

  #purge(): void {
    const now = this.#now();
    for (const [token, expiresAt] of this.#loginTokens) {
      if (now >= expiresAt) this.#loginTokens.delete(token);
    }
    for (const [id, session] of this.#sessions) {
      if (now >= session.expiresAt) this.#sessions.delete(id);
    }
  }

  #readJson(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let failed = false;
      req.on('data', (chunk: Buffer) => {
        if (failed) return;
        size += chunk.length;
        if (size > this.#maxBodyBytes) {
          failed = true;
          reject(new Refused(413, 'body-too-large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('error', (error) => {
        if (!failed) reject(error);
        failed = true;
      });
      req.on('end', () => {
        if (failed) return;
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Refused(400, 'body-json'));
        }
      });
    });
  }

  #json(res: ServerResponse, status: number, body: unknown, cookie?: string): void {
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      ...(cookie ? { 'set-cookie': cookie } : {}),
    });
    res.end(JSON.stringify(body));
  }
}
