import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  KeyringSecretStore,
  MemorySecretStore,
  readSessionInfo,
  type SecretStore,
  writeSessionInfo,
} from '../src/index.ts';

const info = {
  v: 1 as const,
  sessionId: 'abc123',
  channelPath: '\\\\.\\pipe\\bellis-abc123-x',
  channelKey: randomBytes(32).toString('base64url'),
  launcherPid: 4242,
  startedAt: new Date().toISOString(),
};

/** 只返回名字、按字典序。 */
async function exerciseNames(store: SecretStore) {
  assert.deepEqual(await store.names(), []);
  await store.set('b.token', 'secret-b');
  await store.set('a.token', 'secret-a');
  try {
    assert.deepEqual(await store.names(), ['a.token', 'b.token']);
  } finally {
    await store.delete('a.token');
    await store.delete('b.token');
  }
}

async function exercise(store: SecretStore) {
  assert.equal(await store.get('missing'), undefined);
  await store.set('token', 'v1');
  await store.set('token', 'v2');
  assert.equal(await store.get('token'), 'v2');
  assert.equal(await store.delete('token'), true);
  assert.equal(await store.delete('token'), false);
  assert.equal(await store.get('token'), undefined);
  await assert.rejects(store.set('../x', 'v'), /凭据名不合法/);

  assert.equal(await readSessionInfo(store), undefined);
  await writeSessionInfo(store, info);
  assert.deepEqual(await readSessionInfo(store), info);
  await store.set('session', JSON.stringify({ ...info, channelKey: 'short' }));
  await assert.rejects(readSessionInfo(store), /不合法/);
  await store.delete('session');
}

test('内存存储', async () => {
  await exercise(new MemorySecretStore());
  await exerciseNames(new MemorySecretStore());
});

test('系统凭据库', async () => {
  // 每次用独立的服务名，测试互不干扰，也不碰真实的 bellis 条目。
  await exercise(new KeyringSecretStore(`bellis-test-${randomBytes(4).toString('hex')}`));
});

test('系统凭据库列出条目：Windows 与 macOS 支持，Linux 没有 Secret Service 时明确报不支持', async () => {
  const store = new KeyringSecretStore(`bellis-test-${randomBytes(4).toString('hex')}`);
  if (process.platform !== 'linux') {
    await exerciseNames(store);
    return;
  }
  await store.set('a.token', 'secret-a');
  try {
    const names = await store.names().catch((error: Error) => {
      assert.match(error.message, /不支持列出/);
      return undefined;
    });
    if (names !== undefined) assert.deepEqual(names, ['a.token']);
  } finally {
    await store.delete('a.token');
  }
});

test('写入前校验会话信息', async () => {
  await assert.rejects(
    writeSessionInfo(new MemorySecretStore(), { ...info, sessionId: 'Bad!' }),
    /会话信息不合法/,
  );
});
