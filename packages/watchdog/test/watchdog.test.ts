import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createChannelPath, createSessionKey, listen, RpcPeer } from '@bellis/channel';
import { SimObs } from '@bellis/obs';
import { HostHeartbeat, WatchdogActed } from '@bellis/protocol';
import { Watchdog } from '../src/watchdog.ts';

async function setup() {
  const obs = await SimObs.start();
  const path = createChannelPath(`w${randomBytes(4).toString('hex')}`);
  const key = createSessionKey();
  // 宿主一侧：每条连接一个 RpcPeer，收集看门狗的报告（连接序号 + 参数）。
  const peers: RpcPeer[] = [];
  const reports: Array<{ connection: number; params: unknown }> = [];
  const server = await listen(path, {
    key,
    onConnection: (connection) => {
      const index = peers.length;
      const peer = new RpcPeer(connection, { timeoutMs: 1000 });
      peer.onNotification(WatchdogActed, (params) => reports.push({ connection: index, params }));
      peers.push(peer);
    },
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
    peers,
    reports,
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

const beat = (peer: RpcPeer, seq: number) =>
  peer.notify(HostHeartbeat, { seq, mode: 'M1', maintenance: false });

test('连接还在但心跳停止（宿主卡死）时执行应急动作，只执行一次，并在原连接上告知宿主', async () => {
  const s = await setup();
  try {
    await until(() => s.peers.length > 0);
    const peer = s.peers[0] as RpcPeer;
    for (let seq = 1; seq <= 3; seq += 1) {
      beat(peer, seq);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(s.count('watchdog.acting'), 0);
    // 停止发送心跳。
    await until(() => s.reports.length === 1);
    assert.equal(s.obs.currentScene, 'Safe');
    assert.equal(s.obs.muted.get('Stage'), true);
    const report = s.reports[0] as { connection: number; params: Record<string, unknown> };
    assert.equal(report.connection, 0);
    assert.equal(report.params.reason, 'heartbeat-lost');
    assert.equal(report.params.ok, true);
    // 连接保持；在重新收到心跳之前不会再次动作。
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(s.count('watchdog.acting'), 1);
    assert.equal(s.peers.length, 1);
    assert.equal(peer.connection.isOpen, true);
  } finally {
    await s.close();
  }
});

test('重新收到心跳后重新武装', async () => {
  const s = await setup();
  try {
    await until(() => s.count('watchdog.acted') === 1);
    beat(s.peers[0] as RpcPeer, 1);
    // 报告在 watchdog.acted 之后才发出，经通道到达宿主：等报告本身，而不是日志。
    await until(() => s.reports.length === 2);
    assert.equal(s.count('watchdog.acted'), 2);
  } finally {
    await s.close();
  }
});

test('连接意外断开时执行应急动作，重连后补报', async () => {
  const s = await setup();
  try {
    await until(() => s.peers.length > 0);
    const peer = s.peers[0] as RpcPeer;
    beat(peer, 1);
    peer.connection.destroy();
    await until(() => s.reports.length === 1);
    const report = s.reports[0] as { connection: number; params: Record<string, unknown> };
    assert.equal(report.connection, 1);
    assert.equal(report.params.reason, 'connection-lost');
    assert.equal(s.obs.currentScene, 'Safe');
  } finally {
    await s.close();
  }
});
