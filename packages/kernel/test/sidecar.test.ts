import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createChannelPath, createSessionKey, listen } from '@bellis/channel';
import {
  ChannelHub,
  definePlugin,
  defineService,
  SidecarHostService,
  type SidecarService,
  sidecarPlugin,
  sleep,
  systemClock,
} from '../src/index.ts';
import { base, catalog, entry, harness } from './helpers.ts';

const Echo = defineService<SidecarService>('echo', 1);
const fixture = fileURLToPath(new URL('./fixtures/echo-sidecar.ts', import.meta.url));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function setup(args: string[] = []) {
  const h = harness({ activateTimeoutMs: 5000, retryDelaysMs: [50, 50, 50] });
  const credentials = {
    path: createChannelPath(`k${randomBytes(4).toString('hex')}`),
    key: createSessionKey(),
  };
  const hub = new ChannelHub();
  const server = await listen(credentials.path, {
    key: credentials.key,
    onConnection: (connection) => hub.accept(connection),
    onRejected: () => {},
    onError: (error) => {
      throw error;
    },
  });
  h.kernel.provideCore(SidecarHostService, { credentials, hub });

  const replies: unknown[] = [];
  const echo = sidecarPlugin({
    manifest: {
      id: 'echo-sidecar',
      version: '1.0.0',
      tier: 'ordinary',
      provides: [Echo.ref],
      inject: [],
      permissions: [],
    },
    command: process.execPath,
    args: [fixture, ...args],
  });
  const user = definePlugin({
    manifest: { ...base, id: 'echo-user', inject: [Echo.ref] },
    async activate(ctx) {
      replies.push(await ctx.service(Echo).request('echo.say', { text: '你好' }));
    },
  });
  h.kernel.add([entry('echo', 'echo-sidecar'), entry('user', 'echo-user')], catalog(echo, user));
  await h.kernel.settled();
  return {
    ...h,
    replies,
    close: async () => {
      await h.kernel.shutdown();
      await server.close();
    },
  };
}

test('sidecar 经握手注册服务，依赖方经 RPC 使用', async () => {
  const s = await setup();
  try {
    assert.equal(s.state('echo').state, 'active');
    assert.equal(s.state('user').state, 'active');
    assert.equal((s.replies[0] as { text: string }).text, '你好');
  } finally {
    await s.close();
  }
});

test('sidecar 崩溃后服务被撤回、依赖方回到 WAITING，重启后恢复', async () => {
  const s = await setup();
  try {
    const { pid } = s.replies[0] as { pid: number };
    process.kill(pid, 'SIGKILL');
    // 等内核观察到退出并完成卸载。
    for (let i = 0; i < 100 && s.state('echo').state === 'active'; i += 1)
      await sleep(systemClock(), 10);
    await s.kernel.settled();
    assert.ok(['failed', 'waiting', 'loading'].includes(s.state('echo').state));
    assert.notEqual(s.state('user').state, 'active');

    for (let i = 0; i < 300 && s.state('user').state !== 'active'; i += 1)
      await sleep(systemClock(), 10);
    assert.equal(s.state('user').state, 'active');
    const second = s.replies[1] as { pid: number };
    assert.notEqual(second.pid, pid);
  } finally {
    await s.close();
  }
});

test('停用时按停止顺序结束 sidecar 进程', async () => {
  const s = await setup();
  const { pid } = s.replies[0] as { pid: number };
  await s.kernel.disable('echo');
  assert.equal(s.state('user').state, 'waiting');
  assert.equal(isAlive(pid), false);
  await s.close();
});

test('sidecar 声明的服务与清单不一致时加载失败', async () => {
  const s = await setup(['other@1']);
  try {
    assert.equal(s.state('echo').state, 'failed');
    assert.match(s.state('echo').reason ?? '', /与清单 echo@1 不一致/);
  } finally {
    await s.close();
  }
});
