import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { systemClock } from '@bellis/kernel';
import { EngineError, Link } from '../src/index.ts';

const SECRET = 'link-test-secret-value';

/** 只回 HTTP 错误、不做 WebSocket 升级的本机服务器。 */
async function rejecting(status: number, body: string, headers: Record<string, string> = {}) {
  const server: Server = createServer((_, response) => {
    response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    response.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${port}/ws`, close: () => server.close() };
}

function open(url: string) {
  return Link.open({
    url,
    headers: { 'X-Api-Key': SECRET },
    clock: systemClock(),
    timeoutMs: 2000,
    maxPayload: 1024,
  });
}

test('握手被拒：错误带上状态码、厂商写的原因与 logid，抹掉凭据；401 标为鉴权失败', async () => {
  const server = await rejecting(
    401,
    JSON.stringify({ error: `invalid key ${SECRET}`, message: 'requested grant not found' }),
    { 'X-Tt-Logid': 'log-123' },
  );
  try {
    await assert.rejects(open(server.url), (error: unknown) => {
      assert.ok(error instanceof EngineError);
      assert.equal(error.auth, true);
      assert.match(error.message, /^鉴权失败（HTTP 401）：/);
      assert.match(error.message, /requested grant not found/);
      assert.match(error.message, /logid log-123/);
      assert.ok(!error.message.includes(SECRET));
      return true;
    });
  } finally {
    server.close();
  }
});

test('握手被拒：其它状态码是建连被拒，不算鉴权失败；没有响应体时只报状态码', async () => {
  const server = await rejecting(404, '');
  try {
    await assert.rejects(open(server.url), (error: unknown) => {
      assert.ok(error instanceof EngineError);
      assert.equal(error.auth, false);
      assert.equal(error.message, '建连被拒（HTTP 404）');
      return true;
    });
  } finally {
    server.close();
  }
});
