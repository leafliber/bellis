import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { RpcErrorCode } from '@bellis/protocol';
import { ChannelError, RpcError, RpcPeer } from '../src/index.ts';
import { connectedPair } from './helpers.ts';

async function rpcPair() {
  const pair = await connectedPair();
  const client = new RpcPeer(pair.client, { timeoutMs: 1000 });
  const server = new RpcPeer(pair.server, { timeoutMs: 1000 });
  return { ...pair, clientRpc: client, serverRpc: server };
}

test('双方都能请求与响应', async () => {
  const p = await rpcPair();
  try {
    p.serverRpc.handle('math.add', ({ a, b }) => (a as number) + (b as number));
    p.clientRpc.handle('host.ping', () => undefined);
    assert.equal(await p.clientRpc.request('math.add', { a: 1, b: 2 }), 3);
    assert.equal(await p.serverRpc.request('host.ping'), null);
  } finally {
    await p.close();
  }
});

test('未知方法返回 MethodNotFound', async () => {
  const p = await rpcPair();
  try {
    await assert.rejects(
      p.clientRpc.request('no.such'),
      (error) => error instanceof RpcError && error.code === RpcErrorCode.MethodNotFound,
    );
  } finally {
    await p.close();
  }
});

test('处理函数抛出 RpcError 时原样传回，其它异常不外泄细节', async () => {
  const p = await rpcPair();
  try {
    p.serverRpc.handle('a.fail', () => {
      throw new RpcError(1001, '不允许', { reason: 'x' });
    });
    p.serverRpc.handle('a.crash', () => {
      throw new Error('内部细节');
    });
    await assert.rejects(p.clientRpc.request('a.fail'), (error) => {
      assert.ok(error instanceof RpcError);
      assert.deepEqual([error.code, error.message, error.data], [1001, '不允许', { reason: 'x' }]);
      return true;
    });
    await assert.rejects(p.clientRpc.request('a.crash'), (error) => {
      assert.ok(error instanceof RpcError);
      assert.equal(error.code, RpcErrorCode.InternalError);
      assert.doesNotMatch(error.message, /内部细节/);
      return true;
    });
  } finally {
    await p.close();
  }
});

test('超过截止时间以 timeout 失败', async () => {
  const p = await rpcPair();
  try {
    p.serverRpc.handle('a.hang', () => new Promise(() => {}));
    await assert.rejects(
      p.clientRpc.request('a.hang', {}, { timeoutMs: 50 }),
      (error) => error instanceof ChannelError && error.code === 'timeout',
    );
  } finally {
    await p.close();
  }
});

test('调用方可以中止请求', async () => {
  const p = await rpcPair();
  try {
    p.serverRpc.handle('a.hang', () => new Promise(() => {}));
    const controller = new AbortController();
    const pending = p.clientRpc.request('a.hang', {}, { signal: controller.signal });
    controller.abort(new Error('取消'));
    await assert.rejects(pending, /取消/);
  } finally {
    await p.close();
  }
});

test('连接关闭时未完成的请求失败，处理中的请求收到中止', async () => {
  const p = await rpcPair();
  const aborted = Promise.withResolvers<void>();
  p.serverRpc.handle('a.hang', (_params, { signal }) => {
    signal.addEventListener('abort', () => aborted.resolve());
    return new Promise(() => {});
  });
  const pending = p.clientRpc.request('a.hang');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await p.close();
  await assert.rejects(
    pending,
    (error) => error instanceof ChannelError && error.code === 'closed',
  );
  await aborted.promise;
});

test('通知送达对应的处理函数', async () => {
  const p = await rpcPair();
  try {
    const got = Promise.withResolvers<unknown>();
    p.serverRpc.onNotification('host.heartbeat', got.resolve);
    p.clientRpc.notify('host.heartbeat', { seq: 7 });
    assert.deepEqual(await got.promise, { seq: 7 });
  } finally {
    await p.close();
  }
});

test('不合法的消息得到 InvalidRequest，id 为 null', async () => {
  const p = await rpcPair();
  try {
    const reply = once(p.client, 'message');
    p.client.send({ jsonrpc: '2.0', method: 'Bad Name', id: 1 });
    const [message] = await reply;
    assert.deepEqual(message, {
      jsonrpc: '2.0',
      id: null,
      error: { code: RpcErrorCode.InvalidRequest, message: 'Invalid Request' },
    });
  } finally {
    await p.close();
  }
});

test('同名方法只能有一个处理函数，撤销后可以重新注册', async () => {
  const p = await rpcPair();
  try {
    const dispose = p.serverRpc.handle('a.b', () => 1);
    assert.throws(() => p.serverRpc.handle('a.b', () => 2));
    dispose();
    p.serverRpc.handle('a.b', () => 2);
    assert.equal(await p.clientRpc.request('a.b'), 2);
  } finally {
    await p.close();
  }
});
