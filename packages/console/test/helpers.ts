import { request } from 'node:http';

export interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface Call {
  method?: string;
  path?: string;
  /** 原样发出的请求头；不给 host 时不发 Host。 */
  headers?: Record<string, string>;
  body?: string;
}

/** 发一个请求，请求头完全由调用方决定（含 Host、Origin、Sec-Fetch-*）。 */
export function send(port: number, call: Call): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: call.method ?? 'GET',
        path: call.path ?? '/',
        headers: call.headers ?? {},
        setHost: false,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(call.body);
  });
}

/** 浏览器从操作台页面发出的请求头（同源）。 */
export function pageHeaders(
  port: number,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    host: `127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
    'sec-fetch-site': 'same-origin',
    ...extra,
  };
}

/** 页面登录：用一次性令牌换会话，返回 cookie 与 CSRF 令牌。 */
export async function login(port: number, token: string) {
  const reply = await send(port, {
    method: 'POST',
    path: '/api/login',
    headers: pageHeaders(port, { 'content-type': 'application/json' }),
    body: JSON.stringify({ token }),
  });
  if (reply.status !== 200) throw new Error(`登录失败：${reply.status}`);
  const setCookie = ([] as string[]).concat(reply.headers['set-cookie'] ?? []);
  const cookie = setCookie[0]?.split(';')[0] ?? '';
  const { csrf } = JSON.parse(reply.body) as { csrf: string };
  return { cookie, csrf, setCookie: setCookie[0] ?? '' };
}

/** 带会话发写请求。 */
export function post(
  port: number,
  path: string,
  session: { cookie: string; csrf: string },
  body: unknown,
) {
  return send(port, {
    method: 'POST',
    path,
    headers: pageHeaders(port, {
      'content-type': 'application/json',
      cookie: session.cookie,
      'x-bellis-csrf': session.csrf,
    }),
    body: JSON.stringify(body),
  });
}
