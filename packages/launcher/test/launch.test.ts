import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OBS_SECRET, writeObsSecret } from '@bellis/config';
import { SimObs } from '@bellis/obs';
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

  has(event: string): boolean {
    return this.lines.some((line) => line.event === event);
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
const simConfig = fileURLToPath(new URL('../../../config/sim.json', import.meta.url));

async function start() {
  // 独立的服务名与临时存储，不碰真实的 bellis 条目与本机运行数据。
  const id = randomBytes(4).toString('hex');
  const service = `bellis-test-${id}`;
  const store = new KeyringSecretStore(service);
  const obs = await SimObs.start();
  await writeObsSecret(store, { url: obs.url });
  const dbPath = join(tmpdir(), `bellis-launch-${id}.db`);
  const configPath = join(tmpdir(), `bellis-launch-${id}.json`);
  const config = JSON.parse(readFileSync(simConfig, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...config, storePath: dbPath }));
  const session = await launch({
    configPath,
    secretService: service,
    host: { command: process.execPath, args: [script('@bellis/host/main')] },
    watchdog: { command: process.execPath, args: [script('@bellis/watchdog/main')] },
    stdout: 'pipe',
  });
  return {
    store,
    obs,
    session,
    host: new EventLog(session.host.stdout),
    watchdog: new EventLog(session.watchdog.stdout),
    async cleanup() {
      await store.delete(OBS_SECRET);
      await obs.close();
      for (const path of [configPath, dbPath, `${dbPath}-wal`, `${dbPath}-shm`])
        rmSync(path, { force: true });
    },
  };
}

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('条件未在时限内满足');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('启动器分别拉起宿主与看门狗；计划内停止时宿主自己切安全场景，看门狗不动作', async () => {
  const s = await start();
  try {
    const hostReady = await s.host.wait('host.ready');
    const watchdogReady = await s.watchdog.wait('watchdog.ready');
    await s.watchdog.wait('watchdog.connected');

    // 两者都是启动器的子进程，看门狗不是宿主的子进程。
    assert.equal(hostReady.ppid, process.pid);
    assert.equal(watchdogReady.ppid, process.pid);
    assert.equal(hostReady.mode, 'safe-stop');
    assert.deepEqual(await readSessionInfo(s.store), s.session.info);

    const result = await s.session.stop();
    assert.equal(result.host.stage, 'shutdown');
    assert.equal(result.watchdog.stage, 'stdin-eof');
    await s.watchdog.wait('watchdog.host-stopped');
    assert.equal(s.watchdog.has('watchdog.acting'), false);
    assert.equal(s.obs.currentScene, 'Safe');
    assert.equal(await readSessionInfo(s.store), undefined);
  } finally {
    await s.cleanup();
  }
});

test('宿主崩溃后看门狗仍在运行，静音 Stage 源、切安全场景并呼叫操作员', async () => {
  const s = await start();
  try {
    await s.watchdog.wait('watchdog.connected');
    assert.equal(s.obs.currentScene, 'Live');
    s.session.host.kill();
    await s.session.host.exited;
    const acted = await s.watchdog.wait('watchdog.acted');
    assert.equal(acted.ok, true);
    await s.watchdog.wait('watchdog.paged');
    assert.equal(s.obs.currentScene, 'Safe');
    assert.equal(s.obs.muted.get('Stage'), true);
    assert.equal(s.session.watchdog.status, undefined);
  } finally {
    const result = await s.session.stop();
    assert.equal(result.host.stage, 'already-exited');
    assert.equal(result.watchdog.stage, 'stdin-eof');
    await s.cleanup();
  }
});

test('看门狗意外退出后由启动器重启，并重新连上宿主', async () => {
  const s = await start();
  try {
    const first = s.session.watchdog;
    first.kill();
    await first.exited;
    await until(() => s.session.watchdog !== first);
    assert.notEqual(s.session.watchdog.pid, first.pid);
    const restarted = new EventLog(s.session.watchdog.stdout);
    await restarted.wait('watchdog.connected');
  } finally {
    const result = await s.session.stop();
    assert.equal(result.watchdog.stage, 'stdin-eof');
    await s.cleanup();
  }
});
