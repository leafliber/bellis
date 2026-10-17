/**
 * 本地 TTS 代理插件与真实的 Python sidecar（假后端）：先 `uv sync --locked`。
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createChannelPath, createSessionKey, listen } from '@bellis/channel';
import {
  ChannelHub,
  catalog,
  definePlugin,
  Kernel,
  type ResolvedEntry,
  readJsonFile,
  resolveProfile,
  SidecarHostService,
  systemClock,
  type Transition,
} from '@bellis/kernel';
import { type SafetyConfig, SafetyCore, SafetyService, safetyFacade } from '@bellis/safety';
import { StateStore } from '@bellis/store';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import Value from 'typebox/value';
import { localTts, type Synthesis, type Tts, TtsService, venvPython } from '../src/index.ts';

const safetyConfig: SafetyConfig = {
  simulation: true,
  leaseTtlMs: {},
  leaseCapabilities: {},
  presenceTtlMs: 60_000,
  rateLimits: {},
  guardTimeoutMs: 200,
  emergency: { stageSource: 'Stage', safeScene: 'Safe', stopStream: false },
  unattendedGatesSatisfied: false,
};

const SAMPLES_PER_CHAR = 1600;
const CHUNK_SAMPLES = 800;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitUntil(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`条件未在 ${timeoutMs}ms 内满足`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function entry(id: string, plugin: string, config: unknown = {}): ResolvedEntry {
  return { id, plugin, config, disabled: false, explicitSwitch: false, grant: [] };
}

interface Ready {
  pid: number;
  processes: number[];
  sampleRate: number;
}

async function setup(fake: Record<string, unknown> = {}) {
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const transitions: Transition[] = [];
  const store = StateStore.open({ path: ':memory:' });
  store.recover();
  const clock = systemClock();
  let kernel: Kernel | undefined;
  const safety = new SafetyCore({
    store,
    clock,
    config: safetyConfig,
    // 测试中没有 OBS：安全停止下不会走到急停路径。
    obs: { ready: false, run: async () => ({ ok: false, results: [] }) },
    permissionsOf: (holder) => kernel?.permissionsOf(holder),
    watchdogConnected: () => false,
  });
  const host = new Kernel({
    clock,
    safety: safety.kernelHooks(),
    log: (event, fields) => logs.push({ event, fields }),
    onTransition: (transition) => transitions.push(transition),
    activateTimeoutMs: 30_000,
    retryDelaysMs: [100, 100, 100],
  });
  kernel = host;
  host.provideScoped(SafetyService, ({ instanceId }) => safetyFacade(safety, instanceId));

  const credentials = {
    path: createChannelPath(`t${randomBytes(4).toString('hex')}`),
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
  host.provideCore(SidecarHostService, { credentials, hub });

  /** 依赖方：每次激活时记下拿到的 tts@1。 */
  const users: Tts[] = [];
  const user = definePlugin({
    manifest: {
      id: 'tts-user',
      version: '1.0.0',
      tier: 'ordinary',
      provides: [],
      inject: [TtsService.ref],
      permissions: [],
      process: 'in-process',
      config: Type.Object({}),
    },
    activate(ctx) {
      users.push(ctx.service(TtsService));
    },
  });
  const config = {
    backend: 'fake',
    fake: { samplesPerChar: SAMPLES_PER_CHAR, chunkSamples: CHUNK_SAMPLES, ...fake },
  };
  host.add([entry('tts', 'tts-local', config), entry('user', 'tts-user')], catalog(localTts, user));
  await host.settled();

  return {
    kernel: host,
    users,
    transitions,
    logs,
    state(id: string) {
      const found = host.snapshot().find((e) => e.id === id);
      if (!found) throw new Error(`没有条目 ${id}`);
      return found;
    },
    events: (type: string) => store.events().filter((event) => event.type === type),
    ready: () =>
      logs.filter((l) => l.event === 'tts-local.ready').map((l) => l.fields as unknown as Ready),
    async close() {
      await host.shutdown();
      await server.close();
      store.close();
    },
  };
}

async function samplesOf(synthesis: Synthesis): Promise<number> {
  let total = 0;
  for await (const frame of synthesis.frames) total += frame.length;
  return total;
}

test('sidecar 握手后提供 tts@1，音频经二进制帧按流送回', async () => {
  const s = await setup({ sampleRate: 16_000, toneHz: 440 });
  try {
    assert.equal(s.state('tts').state, 'active');
    assert.equal(s.state('user').state, 'active');
    const tts = s.users[0] as Tts;
    const synthesis = await tts.synthesize('你好世界', new AbortController().signal);
    assert.equal(synthesis.sampleRate, 16_000);
    assert.equal(synthesis.timing, undefined);
    const frames: Int16Array[] = [];
    for await (const frame of synthesis.frames) frames.push(frame);
    assert.equal(frames.length, (4 * SAMPLES_PER_CHAR) / CHUNK_SAMPLES);
    assert.ok(frames.every((frame) => frame.length === CHUNK_SAMPLES));
    // 440Hz 正弦：第一帧里有非零采样，且不超过振幅。
    const first = frames[0] as Int16Array;
    assert.ok(first.some((sample) => sample !== 0));
    assert.ok(first.every((sample) => Math.abs(sample) <= 6553));

    // 两句并发：各自的帧按流编号归位。
    const [a, b] = await Promise.all([
      tts.synthesize('一二', new AbortController().signal),
      tts.synthesize('一二三', new AbortController().signal),
    ]);
    assert.deepEqual(await Promise.all([samplesOf(a), samplesOf(b)]), [
      2 * SAMPLES_PER_CHAR,
      3 * SAMPLES_PER_CHAR,
    ]);

    const started = s.events('tts.started');
    assert.equal(started.length, 1);
    assert.equal((started[0]?.data as { backend?: string } | undefined)?.backend, 'fake');
  } finally {
    await s.close();
  }
});

test('中止或停止读取时经 rpc.cancel 停止 sidecar 中的生成', async () => {
  const s = await setup({ chunkDelayMs: 50 });
  try {
    const tts = s.users[0] as Tts;
    const text = '这是一句需要合成很久的比较长的测试句子';
    const full = [...text].length * SAMPLES_PER_CHAR;

    // 调用方中止：流安静结束，只拿到一部分音频。
    const abort = new AbortController();
    const synthesis = await tts.synthesize(text, abort.signal);
    let received = 0;
    for await (const frame of synthesis.frames) {
      received += frame.length;
      if (received >= 2 * CHUNK_SAMPLES) abort.abort(new Error('测试中止'));
    }
    assert.ok(received < full);

    // sidecar 一次只合成一句：前一句若没有真正停止，下一句要排队约 2 秒。
    const started = performance.now();
    const next = await tts.synthesize('好', new AbortController().signal);
    assert.equal(await samplesOf(next), SAMPLES_PER_CHAR);
    assert.ok(performance.now() - started < 1000, '取消没有停止 sidecar 中的生成');

    // 消费方停止读取（Stage 截断）：同样取消。
    const dropped = await tts.synthesize(text, new AbortController().signal);
    for await (const _ of dropped.frames) break;
    const again = performance.now();
    assert.equal(await samplesOf(await tts.synthesize('好', new AbortController().signal)), 1600);
    assert.ok(performance.now() - again < 1000, '停止读取没有取消合成');
    assert.equal(s.state('tts').state, 'active');
  } finally {
    await s.close();
  }
});

test('sidecar 崩溃后服务被撤回、依赖方回到 WAITING、记入降级事件；重启后恢复，派生的进程随之退出', async () => {
  const s = await setup({ crashOn: ['崩溃'], workers: 1, chunkDelayMs: 10 });
  try {
    const [first] = s.ready();
    assert.ok(first);
    const worker = first.processes[0] as number;
    assert.equal(first.processes.length, 1);
    assert.ok(isAlive(worker));

    const tts = s.users[0] as Tts;
    const synthesis = await tts.synthesize('这句话会让它崩溃掉', new AbortController().signal);
    let received = 0;
    await assert.rejects(async () => {
      for await (const frame of synthesis.frames) received += frame.length;
    });
    assert.ok(received > 0, '崩溃前送出的音频应已到达');

    await waitUntil(() => s.ready().length >= 2 && s.state('user').state === 'active', 30_000);
    const userStates = s.transitions.filter((t) => t.entryId === 'user').map((t) => t.to);
    assert.ok(userStates.includes('waiting'), '依赖方应回到 WAITING');
    const ttsStates = s.transitions.filter((t) => t.entryId === 'tts').map((t) => t.to);
    assert.ok(ttsStates.includes('failed'));

    const degraded = s.events('tts.degraded');
    assert.equal(degraded.length, 1);
    assert.equal((degraded[0]?.data as { fallback?: string } | undefined)?.fallback, 'unavailable');
    assert.equal(s.events('tts.started').length, 2);

    const second = s.ready()[1] as Ready;
    assert.notEqual(second.pid, first.pid);
    await waitUntil(() => !isAlive(first.pid) && !isAlive(worker));

    const recovered = s.users[1] as Tts;
    assert.equal(
      await samplesOf(await recovered.synthesize('恢复了', new AbortController().signal)),
      3 * SAMPLES_PER_CHAR,
    );
  } finally {
    await s.close();
  }
});

test('停用时按 R-06 的顺序停止 sidecar：应答 shutdown 后退出，派生的进程随之退出', async () => {
  const s = await setup({ workers: 1 });
  try {
    const [ready] = s.ready();
    assert.ok(ready);
    await s.kernel.disable('tts');
    assert.equal(s.state('user').state, 'waiting');
    const stopped = s.logs.find((l) => l.event === 'sidecar.stopped');
    assert.equal(stopped?.fields.stage, 'shutdown');
    assert.equal(stopped?.fields.code, 0);
    assert.equal(isAlive(ready.pid), false);
    await waitUntil(() => !isAlive(ready.processes[0] as number), 5000);
    assert.equal(s.events('tts.degraded').length, 0);
  } finally {
    await s.close();
  }
});

test('示例 profile 中的本地 TTS 默认禁用，配置符合清单', () => {
  const path = fileURLToPath(
    new URL('../../../config/profiles/live.example.json', import.meta.url),
  );
  const found = resolveProfile(readJsonFile(path), []).find((e) => e.plugin === 'tts-local');
  assert.ok(found);
  assert.equal(found.disabled, true);
  const schema = localTts.manifest.config;
  assert.ok(Compile(schema).Check(Value.Default(schema, structuredClone(found.config))));
});

test('按平台定位 uv 工作区虚拟环境里的解释器', () => {
  assert.match(venvPython('root', 'win32'), /\.venv[\\/]Scripts[\\/]python\.exe$/);
  assert.match(venvPython('root', 'linux'), /\.venv[\\/]bin[\\/]python$/);
});
