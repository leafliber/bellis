import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import {
  ChannelError,
  type ChannelErrorCode,
  type Connection,
  connect,
  createSessionKey,
  encodeFrame,
  FrameKind,
  listen,
} from '../src/index.ts';
import { connectedPair, nonce, quiet, RawPeer, testCredentials } from './helpers.ts';

function hasCode(code: ChannelErrorCode) {
  return (error: unknown) => error instanceof ChannelError && error.code === code;
}

/** 启动服务端，记录被拒绝的握手。 */
async function serve(options: { handshakeTimeoutMs?: number; maxPendingHandshakes?: number } = {}) {
  const { path, key } = testCredentials();
  const accepted: Connection[] = [];
  const rejected = Promise.withResolvers<ChannelError>();
  const server = await listen(path, {
    key,
    ...options,
    onConnection: (connection) => accepted.push(connection),
    onRejected: rejected.resolve,
    onError: quiet.onError,
  });
  return { path, key, server, accepted, rejected: rejected.promise };
}

test('双向认证后收发 JSON 与二进制', async () => {
  const pair = await connectedPair();
  try {
    assert.equal(pair.server.role, 'test.client');
    const message = once(pair.server, 'message');
    pair.client.send({ text: '你好' });
    assert.deepEqual((await message)[0], { text: '你好' });

    const binary = once(pair.client, 'binary');
    await pair.server.sendBinary(Buffer.from([1, 2, 3]));
    assert.deepEqual([...(await binary)[0]], [1, 2, 3]);

    const closed = once(pair.server, 'close');
    pair.client.close();
    assert.deepEqual(await closed, [undefined]);
  } finally {
    await pair.close();
  }
});

test('Windows 上实际使用命名管道', { skip: process.platform !== 'win32' }, () => {
  assert.match(testCredentials().path, /^\\\\\.\\pipe\\bellis-/);
});

test('密钥不同时客户端拒绝服务端，服务端不交出连接', async () => {
  const s = await serve();
  try {
    await assert.rejects(
      connect(s.path, 'test.client', { key: createSessionKey() }),
      hasCode('auth-failed'),
    );
    await s.rejected;
    assert.equal(s.accepted.length, 0);
  } finally {
    await s.server.close();
  }
});

test('连到抢注地址时，客户端核验失败后不再发送任何东西', async () => {
  const { path, key } = testCredentials();
  const received: RawPeer[] = [];
  const squatter = createServer((socket) => {
    const peer = new RawPeer(socket);
    received.push(peer);
    void peer.frame(1).then(() => {
      peer.send(FrameKind.Handshake, { v: 1, type: 'challenge', nonce: nonce(), proof: nonce() });
    });
  });
  await new Promise<void>((resolve) => squatter.listen(path, resolve));
  try {
    await assert.rejects(connect(path, 'test.client', { key }), hasCode('auth-failed'));
    const peer = received[0] as RawPeer;
    await peer.closed;
    assert.equal(peer.frames.length, 1);
    assert.equal(peer.json(peer.frames[0] as never).type, 'hello');
  } finally {
    await new Promise((resolve) => squatter.close(resolve));
  }
});

test('客户端证明错误时服务端断开，不回 accept', async () => {
  const s = await serve();
  try {
    const raw = await RawPeer.connect(s.path);
    raw.send(FrameKind.Handshake, { v: 1, type: 'hello', role: 'test.raw', nonce: nonce() });
    assert.equal(raw.json(await raw.frame(1)).type, 'challenge');
    raw.send(FrameKind.Handshake, { v: 1, type: 'proof', proof: nonce() });
    assert.ok(hasCode('auth-failed')(await s.rejected));
    await raw.closed;
    assert.equal(raw.frames.length, 1);
  } finally {
    await s.server.close();
  }
});

test('证明不能反射：把服务端的证明原样回送会被拒绝', async () => {
  const s = await serve();
  try {
    const raw = await RawPeer.connect(s.path);
    raw.send(FrameKind.Handshake, { v: 1, type: 'hello', role: 'test.raw', nonce: nonce() });
    const challenge = raw.json(await raw.frame(1));
    raw.send(FrameKind.Handshake, { v: 1, type: 'proof', proof: challenge.proof });
    assert.ok(hasCode('auth-failed')(await s.rejected));
  } finally {
    await s.server.close();
  }
});

test('认证完成前发送业务数据会被断开', async () => {
  const s = await serve();
  try {
    const raw = await RawPeer.connect(s.path);
    raw.send(FrameKind.Handshake, { v: 1, type: 'hello', role: 'test.raw', nonce: nonce() });
    raw.send(FrameKind.Json, { jsonrpc: '2.0', method: 'x' });
    assert.ok(hasCode('protocol-error')(await s.rejected));
    await raw.closed;
  } finally {
    await s.server.close();
  }
});

test('握手超时会被断开', async () => {
  const s = await serve({ handshakeTimeoutMs: 100 });
  try {
    const raw = await RawPeer.connect(s.path);
    assert.ok(hasCode('handshake-timeout')(await s.rejected));
    await raw.closed;
  } finally {
    await s.server.close();
  }
});

test('认证前的超长帧会被断开', async () => {
  const s = await serve();
  try {
    const raw = await RawPeer.connect(s.path);
    raw.send(FrameKind.Handshake, Buffer.alloc(4096));
    assert.ok(hasCode('frame-too-large')(await s.rejected));
  } finally {
    await s.server.close();
  }
});

test('紧跟在握手之后到达的数据不会丢', async () => {
  const { path, key } = testCredentials();
  const accepted = Promise.withResolvers<unknown>();
  const server = await listen(path, {
    key,
    ...quiet,
    onConnection: (connection) => connection.once('message', accepted.resolve),
  });
  try {
    const raw = await RawPeer.connect(path);
    const clientNonce = nonce();
    raw.send(FrameKind.Handshake, { v: 1, type: 'hello', role: 'test.raw', nonce: clientNonce });
    const challenge = raw.json(await raw.frame(1));
    const proof = createHmac('sha256', key)
      .update(
        JSON.stringify(['bellis-channel/1', 'client', 'test.raw', clientNonce, challenge.nonce]),
      )
      .digest('base64url');
    // 证明与第一条业务消息在同一次写入中到达。
    raw.socket.write(
      Buffer.concat([
        encodeFrame(
          FrameKind.Handshake,
          Buffer.from(JSON.stringify({ v: 1, type: 'proof', proof })),
        ),
        encodeFrame(FrameKind.Json, Buffer.from(JSON.stringify({ n: 1 }))),
      ]),
    );
    assert.deepEqual(await accepted.promise, { n: 1 });
  } finally {
    await server.close();
  }
});

test('地址已被占用时按可能被抢注报错', async () => {
  const s = await serve();
  try {
    await assert.rejects(
      listen(s.path, { key: s.key, ...quiet, onConnection: () => {} }),
      hasCode('address-in-use'),
    );
    const client = await connect(s.path, 'test.client', { key: s.key });
    client.close();
  } finally {
    await s.server.close();
  }
});

test('连不到时报 connect-failed', async () => {
  await assert.rejects(
    connect(testCredentials().path, 'test.client', { key: createSessionKey() }),
    hasCode('connect-failed'),
  );
});

test('角色名不合法时不发起握手', async () => {
  const s = await serve();
  try {
    await assert.rejects(connect(s.path, 'Bad Role', { key: s.key }), hasCode('protocol-error'));
  } finally {
    await s.server.close();
  }
});

test('认证后发送超过上限的消息时，发送方直接抛错', async () => {
  const pair = await connectedPair({ maxFrameBytes: 64 });
  try {
    assert.throws(() => pair.client.send({ text: 'x'.repeat(100) }), hasCode('frame-too-large'));
    assert.ok(pair.client.isOpen);
  } finally {
    await pair.close();
  }
});

test('服务端关闭时断开全部连接', async () => {
  const pair = await connectedPair();
  const closed = once(pair.client, 'close');
  await pair.close();
  await closed;
  assert.equal(pair.client.isOpen, false);
  assert.throws(() => pair.client.send({}), hasCode('closed'));
});

test('接收方收到超过上限的帧时断开', async () => {
  const { path, key } = testCredentials();
  const accepted = Promise.withResolvers<Connection>();
  const server = await listen(path, {
    key,
    ...quiet,
    maxFrameBytes: 16,
    onConnection: accepted.resolve,
  });
  try {
    const client = await connect(path, 'test.client', { key });
    const serverSide = await accepted.promise;
    const closed = once(serverSide, 'close');
    client.send({ text: randomBytes(32).toString('hex') });
    const [error] = await closed;
    assert.ok(hasCode('frame-too-large')(error));
  } finally {
    await server.close();
  }
});

test('会话密钥长度不对时拒绝监听与连接', async () => {
  const { path } = testCredentials();
  await assert.rejects(
    listen(path, { key: Buffer.alloc(16), ...quiet, onConnection: () => {} }),
    hasCode('invalid-key'),
  );
  await assert.rejects(
    connect(path, 'test.client', { key: Buffer.alloc(31) }),
    hasCode('invalid-key'),
  );
});

test('未认证的握手超过上限时，多出的连接被立即断开', async () => {
  const s = await serve({ maxPendingHandshakes: 2 });
  try {
    const idle = [await RawPeer.connect(s.path), await RawPeer.connect(s.path)];
    const third = await RawPeer.connect(s.path);
    assert.ok(hasCode('busy')(await s.rejected));
    await third.closed;
    for (const peer of idle) peer.socket.destroy();
    // 握手位置释放后，正常客户端可以连上。
    await new Promise((resolve) => setTimeout(resolve, 20));
    const client = await connect(s.path, 'test.client', { key: s.key });
    client.close();
  } finally {
    await s.server.close();
  }
});

test('onConnection 抛错时断开连接，并交给 onError', async () => {
  const { path, key } = testCredentials();
  const reported = Promise.withResolvers<Error>();
  const server = await listen(path, {
    key,
    onRejected: () => {},
    onError: reported.resolve,
    onConnection: () => {
      throw new Error('装配失败');
    },
  });
  try {
    const client = await connect(path, 'test.client', { key });
    const closed = once(client, 'close');
    assert.match((await reported.promise).message, /装配失败/);
    await closed;
  } finally {
    await server.close();
  }
});
