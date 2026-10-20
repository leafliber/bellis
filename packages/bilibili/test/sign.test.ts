import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';
import { systemClock } from '@bellis/kernel';
import { ApiError, canonicalString, OpenApi, SIGNED_HEADERS, signedHeaders } from '../src/index.ts';
import {
  ACCESS_KEY_ID,
  ACCESS_KEY_SECRET,
  APP_ID,
  fakePlatform,
  IDENTITY_CODE,
} from './helpers.ts';

const credentials = { accessKeyId: 'key-id', accessKeySecret: 'key-secret' };

test('签名：六个 x-bili 头齐全，时间戳为秒，MD5 为请求体的十六进制摘要', () => {
  const body = '{"code":"abc","app_id":1}';
  const headers = signedHeaders(body, credentials, 1_700_000_000.9, 'nonce-1');
  assert.deepEqual(Object.keys(headers).sort(), [
    'Accept',
    'Authorization',
    'Content-Type',
    ...SIGNED_HEADERS,
  ]);
  assert.equal(headers['x-bili-accesskeyid'], 'key-id');
  assert.equal(headers['x-bili-content-md5'], createHash('md5').update(body).digest('hex'));
  assert.equal(headers['x-bili-signature-method'], 'HMAC-SHA256');
  assert.equal(headers['x-bili-signature-nonce'], 'nonce-1');
  assert.equal(headers['x-bili-signature-version'], '1.0');
  assert.equal(headers['x-bili-timestamp'], '1700000000');
  assert.equal(headers.Accept, 'application/json');
  assert.equal(headers['Content-Type'], 'application/json');
});

test('签名：待签名串按键名字典序拼成 键:值、以换行连接、首尾无换行，HMAC-SHA256 取小写十六进制', () => {
  const body = '{"game_id":"g"}';
  const headers = signedHeaders(body, credentials, 1_700_000_123, 'n');
  const expected = [
    'x-bili-accesskeyid:key-id',
    `x-bili-content-md5:${createHash('md5').update(body).digest('hex')}`,
    'x-bili-signature-method:HMAC-SHA256',
    'x-bili-signature-nonce:n',
    'x-bili-signature-version:1.0',
    'x-bili-timestamp:1700000123',
  ].join('\n');
  const { Accept, Authorization, 'Content-Type': _, ...signed } = headers;
  assert.equal(canonicalString(signed), expected);
  // 键的给出顺序不影响待签名串。
  const reversed = Object.fromEntries(Object.entries(signed).reverse());
  assert.equal(canonicalString(reversed), expected);
  assert.equal(Authorization, createHmac('sha256', 'key-secret').update(expected).digest('hex'));
  assert.match(Authorization ?? '', /^[0-9a-f]{64}$/);
  assert.equal(Accept, 'application/json');
});

test('签名：请求体或任何一个参与签名的头变了，签名就变', () => {
  const base = signedHeaders('{"a":1}', credentials, 100, 'n');
  assert.notEqual(
    signedHeaders('{"a":2}', credentials, 100, 'n').Authorization,
    base.Authorization,
  );
  assert.notEqual(
    signedHeaders('{"a":1}', credentials, 101, 'n').Authorization,
    base.Authorization,
  );
  assert.notEqual(
    signedHeaders('{"a":1}', credentials, 100, 'm').Authorization,
    base.Authorization,
  );
  assert.notEqual(
    signedHeaders('{"a":1}', { ...credentials, accessKeySecret: 'other' }, 100, 'n').Authorization,
    base.Authorization,
  );
});

test('伪平台核验签名：正确的请求通过；改请求体一个字节、改签名、毫秒时间戳、重复 nonce 都被拒', async () => {
  const fake = await fakePlatform();
  try {
    const api = new OpenApi({
      endpoint: fake.endpoint,
      credentials: { accessKeyId: ACCESS_KEY_ID, accessKeySecret: ACCESS_KEY_SECRET },
      clock: systemClock(),
      wallNow: Date.now,
      timeoutMs: 2000,
    });
    const session = await api.start(IDENTITY_CODE, APP_ID, new AbortController().signal);
    assert.equal(session.gameId, 'game-1');
    assert.equal(fake.requests[0]?.verified, true);
    assert.deepEqual(fake.requests[0]?.body, { code: IDENTITY_CODE, app_id: APP_ID });

    const post = (body: string, headers: Record<string, string>) =>
      fetch(`${fake.endpoint}/v2/app/heartbeat`, { method: 'POST', headers, body }).then(
        (r) => r.json() as Promise<{ code: number }>,
      );
    const body = JSON.stringify({ game_id: session.gameId });
    const secret = { accessKeyId: ACCESS_KEY_ID, accessKeySecret: ACCESS_KEY_SECRET };
    const now = () => Math.floor(Date.now() / 1000);

    assert.equal((await post(body, signedHeaders(body, secret, now(), 'ok-1'))).code, 0);
    // 改请求体的一个字节（签名不变）：MD5 对不上。
    const tampered = body.replace('game-1', 'game-2');
    assert.equal((await post(tampered, signedHeaders(body, secret, now(), 'ok-2'))).code, 4002);
    // 改 MD5 头使其与改过的请求体一致，但签名仍是旧的：签名对不上。
    const forged = signedHeaders(body, secret, now(), 'ok-3');
    forged['x-bili-content-md5'] = createHash('md5').update(tampered).digest('hex');
    assert.equal((await post(tampered, forged)).code, 4002);
    // 签名改一个字符。
    const flipped = signedHeaders(body, secret, now(), 'ok-4');
    const last = flipped.Authorization?.at(-1) === '0' ? '1' : '0';
    flipped.Authorization = `${flipped.Authorization?.slice(0, -1)}${last}`;
    assert.equal((await post(body, flipped)).code, 4002);
    // 时间戳用毫秒：与服务器相差远超 10 分钟。
    assert.equal((await post(body, signedHeaders(body, secret, Date.now(), 'ok-5'))).code, 4003);
    // 错的密钥。
    const wrong = { ...secret, accessKeySecret: 'not-the-secret' };
    assert.equal((await post(body, signedHeaders(body, wrong, now(), 'ok-6'))).code, 4002);
    // nonce 重复。
    assert.equal((await post(body, signedHeaders(body, secret, now(), 'ok-1'))).code, 4004);
    // 缺一个参与签名的头。
    const missing = signedHeaders(body, secret, now(), 'ok-7');
    delete missing['x-bili-signature-version'];
    assert.equal((await post(body, missing)).code, 4001);
  } finally {
    await fake.close();
  }
});

test('接口错误带平台错误码，说明里抹掉凭据；网络错误没有错误码', async () => {
  const fake = await fakePlatform();
  try {
    const api = new OpenApi({
      endpoint: fake.endpoint,
      credentials: { accessKeyId: ACCESS_KEY_ID, accessKeySecret: ACCESS_KEY_SECRET },
      clock: systemClock(),
      wallNow: Date.now,
      timeoutMs: 2000,
    });
    fake.failNext.start.push(7002);
    await assert.rejects(
      api.start(IDENTITY_CODE, APP_ID, new AbortController().signal),
      (error: unknown) => error instanceof ApiError && error.code === 7002 && !!error.requestId,
    );
    const offline = new OpenApi({
      endpoint: 'http://127.0.0.1:1',
      credentials: { accessKeyId: ACCESS_KEY_ID, accessKeySecret: ACCESS_KEY_SECRET },
      clock: systemClock(),
      wallNow: Date.now,
      timeoutMs: 2000,
    });
    await assert.rejects(
      offline.heartbeat('g', new AbortController().signal),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === undefined &&
        !error.message.includes(ACCESS_KEY_SECRET),
    );
  } finally {
    await fake.close();
  }
});
