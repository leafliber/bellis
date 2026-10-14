import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  type Connection,
  createChannelPath,
  createSessionKey,
  listen,
  RpcPeer,
} from '@bellis/channel';
import { SimObs } from '@bellis/obs';
import { HostHeartbeat } from '@bellis/protocol';
import { Watchdog } from '../src/watchdog.ts';

async function setup() {
  const obs = await SimObs.start();
  const path = createChannelPath(`w${randomBytes(4).toString('hex')}`);
  const key = createSessionKey();
  const connections: Connection[] = [];
  const server = await listen(path, {
    key,
    onConnection: (connection) => connections.push(connection),
    onRejected: () => {},
    onError: (error) => {
      throw error;
    },
  });
  const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const watchdog = new Watchdog({
    channelPath: path,
    key,
    obs: { url: obs.url },
    policy: { stageSource: 'Stage', safeScene: 'Safe', stopStream: false },
    heartbeatTimeoutMs: 150,
    log: (event, fields) => events.push({ event, ...(fields ? { fields } : {}) }),
    reconnectDelayMs: 20,
  });
  watchdog.start();
  return {
    obs,
    connections,
    events,
    count: (event: string) => events.filter((e) => e.event === event).length,
    async close() {
      watchdog.stop();
      await server.close();
      await obs.close();
    },
  };
}

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('条件未在时限内满足');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('连接还在但心跳停止（宿主卡死）时执行应急动作，只执行一次', async () => {
  const s = await setup();
  try {
    await until(() => s.connections.length > 0);
    const rpc = new RpcPeer(s.connections[0] as Connection, { timeoutMs: 1000 });
    for (let seq = 1; seq <= 3; seq += 1) {
      rpc.notify(HostHeartbeat, { seq, mode: 'M0', maintenance: false });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(s.count('watchdog.acting'), 0);
    // 停止发送心跳。
    await until(() => s.count('watchdog.acted') === 1);
    assert.equal(s.obs.currentScene, 'Safe');
    assert.equal(s.obs.muted.get('Stage'), true);
    assert.equal(
      s.events.find((e) => e.event === 'watchdog.acting')?.fields?.reason,
      'heartbeat-lost',
    );
    // 看门狗断开后重连；新连接上没有心跳，但在重新收到心跳之前不会再次动作。
    await until(() => s.connections.length > 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(s.count('watchdog.acting'), 1);
  } finally {
    await s.close();
  }
});

test('重新收到心跳后重新武装', async () => {
  const s = await setup();
  try {
    await until(() => s.count('watchdog.acted') === 1);
    await until(() => s.connections.length > 1);
    const rpc = new RpcPeer(s.connections.at(-1) as Connection, { timeoutMs: 1000 });
    rpc.notify(HostHeartbeat, { seq: 1, mode: 'M0', maintenance: false });
    await until(() => s.count('watchdog.acted') === 2);
  } finally {
    await s.close();
  }
});
