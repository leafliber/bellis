import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ConsoleRoute, ConsoleServer, InvalidParams, SECURITY_HEADERS } from '../src/index.ts';
import { login, pageHeaders, post, send } from './helpers.ts';

async function start(options: { maxSessions?: number } = {}) {
  const clock = { now: 1_000_000 };
  const calls: Array<{ path: string; body: unknown }> = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> | undefined }> = [];
  const route = (path: string, method: 'GET' | 'POST'): ConsoleRoute => ({
    method,
    run(body) {
      calls.push({ path, body });
      if (path === '/api/mode' && (body as { target?: unknown }).target === 'bad')
        throw new InvalidParams();
      return { ok: true, path };
    },
  });
  const server = await ConsoleServer.start({
    routes: {
      '/api/status': route('/api/status', 'GET'),
      '/api/mode': route('/api/mode', 'POST'),
    },
    log: (event, fields) => logs.push({ event, fields }),
    now: () => clock.now,
    ...options,
  });
  return { server, port: server.port, clock, calls, logs };
}

const navigation = (port: number, extra: Record<string, string> = {}) => ({
  host: `127.0.0.1:${port}`,
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
  'sec-fetch-site': 'none',
  ...extra,
});

function assertSecurityHeaders(headers: Record<string, string | string[] | undefined>) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(headers[name], value, name);
  }
  const csp = String(headers['content-security-policy']);
  for (const directive of [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ]) {
    assert.ok(csp.includes(directive), directive);
  }
}

test('只监听 127.0.0.1 的随机端口；页面文档的顶层导航不带会话也能取得，响应带严格的安全头', async () => {
  const s = await start();
  try {
    assert.ok(s.port > 0);
    assert.equal(s.server.url, `http://127.0.0.1:${s.port}/`);
    for (const site of ['none', 'same-origin']) {
      const page = await send(s.port, { headers: navigation(s.port, { 'sec-fetch-site': site }) });
      assert.equal(page.status, 200, site);
      assert.match(String(page.headers['content-type']), /^text\/html/);
      assert.match(page.body, /<script type="module" src="\/console\.js"><\/script>/);
      assertSecurityHeaders(page.headers);
    }
    // 同源的静态资源要带同源的 Origin。
    const script = await send(s.port, { path: '/console.js', headers: pageHeaders(s.port) });
    assert.equal(script.status, 200);
    assert.match(String(script.headers['content-type']), /^text\/javascript/);
    assertSecurityHeaders(script.headers);
    const style = await send(s.port, { path: '/console.css', headers: pageHeaders(s.port) });
    assert.equal(style.status, 200);
  } finally {
    await s.server.close();
  }
});

test('错误的 Host（含 localhost、别的端口、缺失）一律拒绝，拒绝的响应不带原因', async () => {
  const s = await start();
  try {
    const { token } = s.server.issueLogin();
    const session = await login(s.port, token);
    for (const host of [
      `localhost:${s.port}`,
      `127.0.0.1:${s.port + 1}`,
      '127.0.0.1',
      `evil.example:${s.port}`,
      `[::1]:${s.port}`,
    ]) {
      const page = await send(s.port, { headers: navigation(s.port, { host }) });
      assert.equal(page.status, 403, host);
      assert.equal(page.body, '');
      assertSecurityHeaders(page.headers);
      const status = await send(s.port, {
        path: '/api/status',
        headers: { ...pageHeaders(s.port), host, cookie: session.cookie },
      });
      assert.equal(status.status, 403, host);
      assert.equal(status.body, '');
    }
    // 缺 Host 的 HTTP/1.1 请求由 node:http 自己以 400 拒绝（requireHostHeader）。
    const { host: _host, ...withoutHost } = navigation(s.port);
    assert.equal((await send(s.port, { headers: withoutHost })).status, 400);
    assert.ok(s.logs.some((l) => l.event === 'console.refused' && l.fields?.reason === 'host'));
    assert.equal(s.calls.length, 0, '被拒的请求没有调到操作员动作');
  } finally {
    await s.server.close();
  }
});

test('页面文档只在顶层导航时放行；被嵌进 iframe、跨站导航、脚本不带 Origin 都拒绝', async () => {
  const s = await start();
  try {
    const refused = [
      navigation(s.port, { 'sec-fetch-dest': 'iframe' }),
      navigation(s.port, { 'sec-fetch-mode': 'no-cors' }),
      navigation(s.port, { 'sec-fetch-site': 'cross-site' }),
      navigation(s.port, { 'sec-fetch-site': 'same-site' }),
      { host: `127.0.0.1:${s.port}` },
      navigation(s.port, { origin: 'http://127.0.0.1:1' }),
    ];
    for (const headers of refused) {
      assert.equal((await send(s.port, { headers })).status, 403, JSON.stringify(headers));
    }
    // 子资源：缺 Origin、Origin 不同源、跨站的 Sec-Fetch-Site 都拒绝。
    const host = `127.0.0.1:${s.port}`;
    for (const headers of [
      { host },
      { host, origin: `http://localhost:${s.port}` },
      { ...pageHeaders(s.port), 'sec-fetch-site': 'same-site' },
    ]) {
      assert.equal(
        (await send(s.port, { path: '/console.js', headers })).status,
        403,
        JSON.stringify(headers),
      );
    }
    assert.equal((await send(s.port, { path: '/nope', headers: pageHeaders(s.port) })).status, 404);
    assert.equal(
      (await send(s.port, { method: 'POST', path: '/', headers: pageHeaders(s.port) })).status,
      405,
    );
  } finally {
    await s.server.close();
  }
});

test('登录：一次性令牌换 HttpOnly、SameSite=Strict 的会话 cookie 与 CSRF 令牌；令牌重放、过期、错误都被拒', async () => {
  const s = await start();
  try {
    const issued = s.server.issueLogin();
    assert.equal(issued.url, s.server.url);
    assert.equal(issued.expiresInMs, 60_000);
    // 至少 128 位随机的 base64url。
    assert.match(issued.token, /^[A-Za-z0-9_-]{22,}$/);
    const session = await login(s.port, issued.token);
    assert.match(session.setCookie, /^bellis_console=[A-Za-z0-9_-]{43};/);
    assert.match(session.setCookie, /; HttpOnly/);
    assert.match(session.setCookie, /; SameSite=Strict/);
    assert.match(session.setCookie, /; Path=\//);
    assert.match(session.csrf, /^[A-Za-z0-9_-]{43}$/);

    const attempt = (token: string, headers = pageHeaders(s.port)) =>
      send(s.port, {
        method: 'POST',
        path: '/api/login',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
    // 重放用过的令牌。
    const replay = await attempt(issued.token);
    assert.equal(replay.status, 403);
    assert.equal(replay.body, '');
    assert.equal(replay.headers['set-cookie'], undefined);
    // 错误的令牌。
    assert.equal((await attempt('A'.repeat(43))).status, 403);
    // 过期的令牌。
    const late = s.server.issueLogin();
    s.clock.now += 60_000;
    assert.equal((await attempt(late.token)).status, 403);
    // 登录也要同源的 Origin 与 JSON。
    const fresh = s.server.issueLogin();
    const { origin: _origin, ...noOrigin } = pageHeaders(s.port);
    assert.equal((await attempt(fresh.token, noOrigin)).status, 403);
    assert.equal(
      (await attempt(fresh.token, pageHeaders(s.port, { origin: `http://localhost:${s.port}` })))
        .status,
      403,
    );
    const plain = await send(s.port, {
      method: 'POST',
      path: '/api/login',
      headers: pageHeaders(s.port, { 'content-type': 'text/plain' }),
      body: JSON.stringify({ token: fresh.token }),
    });
    assert.equal(plain.status, 415);
    // 被拒的尝试没有消耗令牌，正确的请求仍能登录；之后它也作废。
    await login(s.port, fresh.token);
    assert.equal((await attempt(fresh.token)).status, 403);
    assert.equal(s.server.sessions, 2);
  } finally {
    await s.server.close();
  }
});

test('/api/* 都要会话 cookie：缺 cookie、错 cookie、过期的会话都拒绝；GET 带了 Origin 或 Sec-Fetch-Site 也要同源', async () => {
  const s = await start();
  try {
    const session = await login(s.port, s.server.issueLogin().token);
    const get = (headers: Record<string, string>) => send(s.port, { path: '/api/status', headers });
    const host = `127.0.0.1:${s.port}`;
    assert.equal((await get({ host })).status, 401);
    assert.equal((await get({ host, cookie: 'bellis_console=wrong' })).status, 401);
    assert.equal(
      (await get({ host, cookie: `other=${session.cookie.split('=')[1]}` })).status,
      401,
    );
    // 不带 Origin 与 Sec-Fetch-Site 的 GET（同源 fetch 的 GET 不带 Origin）只要会话。
    const ok = await get({ host, cookie: session.cookie });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { ok: true, path: '/api/status' });
    assertSecurityHeaders(ok.headers);
    assert.equal((await get({ ...pageHeaders(s.port), cookie: session.cookie })).status, 200);
    // 别的同名 cookie 不妨碍（cookie 不按端口隔离）。
    assert.equal((await get({ host, cookie: `bellis_console=x; ${session.cookie}` })).status, 200);
    for (const extra of [
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-site': 'none' },
      { origin: `http://127.0.0.1:${s.port + 1}` },
      { origin: 'null' },
    ]) {
      assert.equal(
        (await get({ host, cookie: session.cookie, ...extra })).status,
        403,
        JSON.stringify(extra),
      );
    }
    assert.equal(
      (await send(s.port, { method: 'POST', path: '/api/status', headers: pageHeaders(s.port) }))
        .status,
      405,
    );
    // 会话有绝对有效期。
    s.clock.now += 12 * 60 * 60_000;
    assert.equal((await get({ host, cookie: session.cookie })).status, 401);
    assert.equal(s.server.sessions, 0);
    assert.deepEqual(
      s.calls.map((c) => c.path),
      ['/api/status', '/api/status', '/api/status'],
    );
  } finally {
    await s.server.close();
  }
});

test('写请求要同源的 Origin、JSON 与会话绑定的 CSRF 令牌，任何一项不符都拒绝且不调操作员动作', async () => {
  const s = await start();
  try {
    const session = await login(s.port, s.server.issueLogin().token);
    const other = await login(s.port, s.server.issueLogin().token);
    const base = pageHeaders(s.port, {
      'content-type': 'application/json',
      cookie: session.cookie,
      'x-bellis-csrf': session.csrf,
    });
    const write = (headers: Record<string, string>, body = '{"target":"M1"}') =>
      send(s.port, { method: 'POST', path: '/api/mode', headers, body });
    const { origin: _origin, ...noOrigin } = base;
    const { 'x-bellis-csrf': _csrf, ...noCsrf } = base;
    const { cookie: _cookie, ...noCookie } = base;
    const cases: Array<[string, Record<string, string>, number]> = [
      ['缺 Origin', noOrigin, 403],
      ['别的端口的 Origin', { ...base, origin: `http://127.0.0.1:${s.port + 1}` }, 403],
      ['localhost 的 Origin', { ...base, origin: `http://localhost:${s.port}` }, 403],
      ['跨站', { ...base, 'sec-fetch-site': 'same-site' }, 403],
      ['缺 CSRF', noCsrf, 403],
      ['错的 CSRF', { ...base, 'x-bellis-csrf': 'x'.repeat(43) }, 403],
      ['别的会话的 CSRF', { ...base, 'x-bellis-csrf': other.csrf }, 403],
      ['缺 cookie', noCookie, 401],
      ['text/plain', { ...base, 'content-type': 'text/plain' }, 415],
      ['表单', { ...base, 'content-type': 'application/x-www-form-urlencoded' }, 415],
      ['错的 Host', { ...base, host: `localhost:${s.port}` }, 403],
    ];
    for (const [label, headers, status] of cases) {
      const reply = await write(headers);
      assert.equal(reply.status, status, label);
      assert.equal(reply.body, '', label);
    }
    assert.equal(s.calls.length, 0);

    // 不是 JSON 的请求体、参数不合法：400。
    assert.equal((await write(base, 'target=M1')).status, 400);
    const invalid = await write(base, '{"target":"bad"}');
    assert.equal(invalid.status, 400);
    assert.deepEqual(JSON.parse(invalid.body), { ok: false, reason: '参数不合法' });
    // 过大的请求体。
    assert.equal((await write(base, JSON.stringify({ target: 'x'.repeat(5000) }))).status, 413);

    const ok = await post(s.port, '/api/mode', session, { target: 'M1' });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { ok: true, path: '/api/mode' });
    // 带参数的 content-type 也算 JSON。
    const charset = await write({ ...base, 'content-type': 'application/json; charset=utf-8' });
    assert.equal(charset.status, 200);
    assert.deepEqual(
      s.calls.map((c) => c.body),
      [{ target: 'bad' }, { target: 'M1' }, { target: 'M1' }],
    );
    assert.equal(
      (await send(s.port, { path: '/api/mode', headers: { ...base, 'content-type': '' } })).status,
      405,
    );
  } finally {
    await s.server.close();
  }
});

test('刷新页面后凭 cookie 取回 CSRF 令牌；注销后会话作废；会话数有上限，超出时作废最早的', async () => {
  const s = await start({ maxSessions: 2 });
  try {
    const first = await login(s.port, s.server.issueLogin().token);
    const again = await send(s.port, {
      path: '/api/session',
      headers: { ...pageHeaders(s.port), cookie: first.cookie },
    });
    assert.equal(again.status, 200);
    assert.equal((JSON.parse(again.body) as { csrf: string }).csrf, first.csrf);
    assert.equal(
      (await send(s.port, { path: '/api/session', headers: pageHeaders(s.port) })).status,
      401,
    );

    s.clock.now += 1;
    const second = await login(s.port, s.server.issueLogin().token);
    s.clock.now += 1;
    const third = await login(s.port, s.server.issueLogin().token);
    assert.equal(s.server.sessions, 2);
    const status = (session: { cookie: string }) =>
      send(s.port, {
        path: '/api/status',
        headers: { ...pageHeaders(s.port), cookie: session.cookie },
      }).then((r) => r.status);
    assert.equal(await status(first), 401);
    assert.equal(await status(second), 200);
    assert.equal(await status(third), 200);

    // 注销也是写请求，要 CSRF。
    const { 'x-bellis-csrf': _csrf, ...noCsrf } = pageHeaders(s.port, {
      'content-type': 'application/json',
      cookie: second.cookie,
      'x-bellis-csrf': second.csrf,
    });
    assert.equal(
      (await send(s.port, { method: 'POST', path: '/api/logout', headers: noCsrf, body: '{}' }))
        .status,
      403,
    );
    const out = await post(s.port, '/api/logout', second, {});
    assert.equal(out.status, 200);
    assert.match(String(([] as string[]).concat(out.headers['set-cookie'] ?? [])[0]), /Max-Age=0/);
    assert.equal(await status(second), 401);
    assert.equal(await status(third), 200);
    assert.equal(s.server.sessions, 1);
  } finally {
    await s.server.close();
  }
});

test('关闭后全部会话与令牌作废，端口不再监听', async () => {
  const s = await start();
  const { token } = s.server.issueLogin();
  await s.server.close();
  await assert.rejects(send(s.port, { headers: navigation(s.port) }));
  assert.equal(s.server.sessions, 0);
  assert.ok(token.length >= 22);
});
