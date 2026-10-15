import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { KeyringSecretStore, readSessionInfo } from '@bellis/secret-store';
import { launch } from '../src/launch.ts';

type LogLine = { event: string; [field: string]: unknown };

/** 收集子进程的结构化日志，等待某个事件出现。 */
class EventLog {
  readonly lines: LogLine[] = [];
  #waiters: Array<() => void> = [];

  constructor(stream: Readable | null) {
    if (!stream) throw new Error('没有可读的输出');
    createInterface({ input: stream }).on('line', (line) => {
      this.lines.push(JSON.parse(line) as LogLine);
      for (const wake of this.#waiters.splice(0)) wake();
    });
  }

  async wait(event: string, timeoutMs = 10_000): Promise<LogLine> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.lines.find((line) => line.event === event);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`未等到 ${event}：${JSON.stringify(this.lines)}`);
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  }
}

const script = (specifier: string) => fileURLToPath(import.meta.resolve(specifier));

async function start() {
  // 独立的服务名，不碰真实的 bellis 条目。
  const service = `bellis-test-${randomBytes(4).toString('hex')}`;
  const store = new KeyringSecretStore(service);
  const session = await launch({
    secretService: service,
    host: { command: process.execPath, args: [script('@bellis/host/main')] },
    watchdog: { command: process.execPath, args: [script('@bellis/watchdog/main')] },
    stdout: 'pipe',
  });
  return {
    store,
    session,
    host: new EventLog(session.host.stdout),
    watchdog: new EventLog(session.watchdog.stdout),
  };
}

test('启动器分别拉起宿主与看门狗，看门狗经 SecretStore 拿到连接信息', async () => {
  const s = await start();
  const hostReady = await s.host.wait('host.ready');
  const watchdogReady = await s.watchdog.wait('watchdog.ready');
  await s.watchdog.wait('watchdog.connected');

  // 两者都是启动器的子进程，看门狗不是宿主的子进程。
  assert.equal(hostReady.ppid, process.pid);
  assert.equal(watchdogReady.ppid, process.pid);
  assert.equal(watchdogReady.sessionId, s.session.info.sessionId);
  assert.deepEqual(await readSessionInfo(s.store), s.session.info);

  const result = await s.session.stop();
  assert.equal(result.host.stage, 'shutdown');
  assert.equal(result.watchdog.stage, 'stdin-eof');
  await s.watchdog.wait('watchdog.host-stopped');
  assert.equal(await readSessionInfo(s.store), undefined);
});

test('宿主崩溃后看门狗仍在运行，并报告宿主丢失', async () => {
  const s = await start();
  try {
    await s.watchdog.wait('watchdog.connected');
    s.session.host.kill();
    await s.session.host.exited;
    await s.watchdog.wait('watchdog.host-lost');
    assert.equal(s.session.watchdog.status, undefined);
  } finally {
    const result = await s.session.stop();
    assert.equal(result.host.stage, 'already-exited');
    assert.equal(result.watchdog.stage, 'stdin-eof');
  }
});

test('看门狗意外退出后由启动器重启，并重新连上宿主', async () => {
  const s = await start();
  try {
    const first = s.session.watchdog;
    first.kill();
    await first.exited;
    for (let i = 0; i < 200 && s.session.watchdog === first; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.notEqual(s.session.watchdog.pid, first.pid);
    const restarted = new EventLog(s.session.watchdog.stdout);
    await restarted.wait('watchdog.connected');
  } finally {
    const result = await s.session.stop();
    assert.equal(result.watchdog.stage, 'stdin-eof');
  }
});
