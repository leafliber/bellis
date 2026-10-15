import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ChannelCredentials,
  type Connection,
  createChannelPath,
  createSessionKey,
  encodeSessionKey,
  listen,
  RpcPeer,
} from '@bellis/channel';
import { ChildEnv, ProcessShutdown } from '@bellis/protocol';
import { baseEnvironment, ManagedProcess } from '../src/index.ts';
import { firstLine, fixture, isAlive, waitUntil } from './helpers.ts';

const GRACE_MS = 500;

/** 起一个通道服务端，再启动连到它的测试子进程。 */
async function startChild(mode: string) {
  const credentials: ChannelCredentials = {
    path: createChannelPath(`p${process.pid}${Math.floor(Math.random() * 1e6)}`.slice(0, 16)),
    key: createSessionKey(),
  };
  const connected = Promise.withResolvers<Connection>();
  const server = await listen(credentials.path, {
    key: credentials.key,
    onConnection: connected.resolve,
    onRejected: () => {},
    onError: (error) => {
      throw error;
    },
  });
  const child = await ManagedProcess.start({
    name: mode,
    command: process.execPath,
    args: [fixture('child.ts'), mode],
    env: {
      ...baseEnvironment(),
      [ChildEnv.ChannelPath]: credentials.path,
      [ChildEnv.ChannelKey]: encodeSessionKey(credentials.key),
    },
    stdout: 'pipe',
  });
  await firstLine(child.stdout, (line) => line === 'ready');
  const connects = mode === 'cooperative' || mode === 'ignore-shutdown';
  const rpc = connects ? new RpcPeer(await connected.promise, { timeoutMs: GRACE_MS }) : undefined;
  const shutdown = () =>
    rpc ? rpc.request(ProcessShutdown, { reason: 'test' }) : Promise.reject(new Error('无连接'));
  return { child, shutdown, close: () => server.close() };
}

test('配合的子进程在 shutdown 请求后退出', async () => {
  const s = await startChild('cooperative');
  try {
    const result = await s.child.stop({ shutdown: s.shutdown, graceMs: GRACE_MS });
    assert.equal(result.stage, 'shutdown');
    assert.equal(result.code, 0);
  } finally {
    await s.close();
  }
});

test('不响应 shutdown 的子进程在 stdin 关闭后退出', async () => {
  const s = await startChild('ignore-shutdown');
  try {
    const result = await s.child.stop({ shutdown: s.shutdown, graceMs: GRACE_MS });
    assert.equal(result.stage, 'stdin-eof');
  } finally {
    await s.close();
  }
});

test('什么都不响应的子进程被强制终止', async () => {
  const s = await startChild('stubborn');
  try {
    const result = await s.child.stop({ shutdown: s.shutdown, graceMs: GRACE_MS });
    assert.equal(result.stage, 'killed');
    assert.equal(isAlive(s.child.pid), false);
  } finally {
    await s.close();
  }
});

test('已经退出的子进程直接返回', async () => {
  const s = await startChild('lifeline-only');
  try {
    s.child.kill();
    await s.child.exited;
    assert.equal((await s.child.stop()).stage, 'already-exited');
  } finally {
    await s.close();
  }
});

test('父进程被强制终止后，子进程随之退出', async () => {
  const parent = await ManagedProcess.start({
    name: 'parent',
    command: process.execPath,
    args: [fixture('parent.ts')],
    env: baseEnvironment(),
    stdout: 'pipe',
  });
  const line = await firstLine(parent.stdout, (l) => l.startsWith('{'));
  const { childPid } = JSON.parse(line) as { childPid: number };
  assert.ok(isAlive(childPid));
  parent.kill();
  await parent.exited;
  await waitUntil(() => !isAlive(childPid), 5000);
});

test('子进程只拿到显式传入的环境变量', async () => {
  process.env.BELLIS_TEST_MARKER = 'leak';
  try {
    const child = await ManagedProcess.start({
      name: 'env',
      command: process.execPath,
      args: [fixture('child.ts'), 'env'],
      env: { ...baseEnvironment(), BELLIS_EXPLICIT: '1' },
      stdout: 'pipe',
    });
    const keys = JSON.parse(await firstLine(child.stdout, (l) => l.startsWith('['))) as string[];
    assert.ok(keys.includes('BELLIS_EXPLICIT'));
    assert.ok(!keys.includes('BELLIS_TEST_MARKER'));
    await child.exited;
  } finally {
    delete process.env.BELLIS_TEST_MARKER;
  }
});

test('可执行文件不存在时启动失败', async () => {
  await assert.rejects(
    ManagedProcess.start({
      name: 'missing',
      command: 'bellis-no-such-binary',
      args: [],
      env: baseEnvironment(),
    }),
    /ENOENT/,
  );
});
