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

async function exercise(store: SecretStore) {
  assert.equal(await store.get('missing'), undefined);
  assert.deepEqual(await store.names(), []);
  await store.set('b.token', 'secret-b');
  await store.set('a.token', 'secret-a');
  assert.deepEqual(await store.names(), ['a.token', 'b.token']);
  await store.delete('a.token');
  await store.delete('b.token');
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
});

test('系统凭据库', async () => {
  // 每次用独立的服务名，测试互不干扰，也不碰真实的 bellis 条目。
  await exercise(new KeyringSecretStore(`bellis-test-${randomBytes(4).toString('hex')}`));
});

test('写入前校验会话信息', async () => {
  await assert.rejects(
    writeSessionInfo(new MemorySecretStore(), { ...info, sessionId: 'Bad!' }),
    /会话信息不合法/,
  );
});
