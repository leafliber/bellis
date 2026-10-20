/**
 * 本地 TTS 代理插件与真实的 Python sidecar（假后端）：先 `uv sync --locked`。
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createChannelPath, createSessionKey, listen } from '@bellis/channel';
import {
  ChannelHub,
  ClockService,
  catalog,
  DataDirService,
  definePlugin,
  Kernel,
  RandomService,
  type ResolvedEntry,
  readJsonFile,
  resolveProfile,
  SidecarHostService,
  systemClock,
  systemRandom,
  type Transition,
} from '@bellis/kernel';
import { type SafetyConfig, SafetyCore, SafetyService, safetyFacade } from '@bellis/safety';
import { StateStore } from '@bellis/store';
import {
  otlpLineProblems,
  parseLines,
  type Telemetry,
  TelemetryService,
  telemetry,
} from '@bellis/telemetry';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import Value from 'typebox/value';
import {
  LocalTtsConfig,
  LocalTtsService,
  localTts,
  type Synthesis,
  sidecarArgs,
  type Tts,
  type TtsEngine,
  type TtsOption,
  type TtsRouting,
  TtsRoutingService,
  TtsService,
  ttsRouter,
  venvPython,
} from '../src/index.ts';

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
  qos: string;
}

/**
 * 内核、安全核（内存存储）与本机通道，加上本地 TTS 条目。给出 `order` 时再加上 TTS 路由，
 * 依赖方改为使用 `tts@1`；否则依赖方直接使用 `tts.local@1`。给出 `dataDir` 时先加上写文件的遥测。
 */
async function setup(fake: Record<string, unknown> = {}, order?: TtsOption[], dataDir?: string) {
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
  if (dataDir) {
    host.provideCore(ClockService, clock);
    host.provideCore(RandomService, systemRandom());
    host.provideCore(DataDirService, { path: dataDir });
  }

  /** 依赖方：每次激活时记下拿到的服务。 */
  const users: Tts[] = [];
  const token = order ? TtsService : LocalTtsService;
  const user = definePlugin({
    manifest: {
      id: 'tts-user',
      version: '1.0.0',
      tier: 'ordinary',
      provides: [],
      inject: [token.ref],
      permissions: [],
      process: 'in-process',
      config: Type.Object({}),
    },
    activate(ctx) {
      users.push(ctx.service(token));
    },
  });
  const config = {
    backend: 'fake',
    fake: { samplesPerChar: SAMPLES_PER_CHAR, chunkSamples: CHUNK_SAMPLES, ...fake },
  };
  host.add(
    [
      ...(dataDir
        ? [entry('telemetry', 'telemetry', { flushIntervalMs: 50, eventLoopIntervalMs: 0 })]
        : []),
      entry('tts-local', 'tts-local', config),
      ...(order ? [entry('tts', 'tts-router', { order })] : []),
      entry('user', 'tts-user'),
    ],
    catalog(telemetry, localTts, ttsRouter, user),
  );
  await host.settled();

  const resolve = <T>(t: { name: string; major: number }): T | undefined => {
    const found = host.services.resolve(t.name, t.major);
    return 'missing' in found ? undefined : (found.impl as T);
  };
  return {
    kernel: host,
    users,
    transitions,
    logs,
    engine: () => resolve<TtsEngine>(LocalTtsService),
    routing: () => resolve<TtsRouting>(TtsRoutingService),
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

test('握手后即激活、模型在后台加载；就绪后音频经二进制帧按流送回', async () => {
  const s = await setup({ sampleRate: 16_000, toneHz: 440, loadDelayMs: 300 });
  try {
    assert.equal(s.state('tts-local').state, 'active');
    const engine = s.engine() as TtsEngine;
    assert.equal(engine.ready, false);
    assert.equal(engine.status, '模型加载中');
    await assert.rejects(engine.synthesize('你好', new AbortController().signal), /模型加载中/);
    assert.equal(s.events('tts.started').length, 0);

    await waitUntil(() => engine.ready);
    assert.equal(engine.status, '就绪');
    const synthesis = await engine.synthesize('你好世界', new AbortController().signal);
    assert.equal(synthesis.sampleRate, 16_000);
    const frames: Int16Array[] = [];
    for await (const frame of synthesis.frames) frames.push(frame);
    assert.equal(frames.length, (4 * SAMPLES_PER_CHAR) / CHUNK_SAMPLES);
    assert.ok(frames.every((frame) => frame.length === CHUNK_SAMPLES));
    // 440Hz 正弦：第一帧里有非零采样，且不超过振幅。
    const first = frames[0] as Int16Array;
    assert.ok(first.some((sample) => sample !== 0));
    assert.ok(first.every((sample) => Math.abs(sample) <= 6553));
    assert.equal(synthesis.totalSamples, 4 * SAMPLES_PER_CHAR);

    // 两句并发：各自的帧按流编号归位。
    const [a, b] = await Promise.all([
      engine.synthesize('一二', new AbortController().signal),
      engine.synthesize('一二三', new AbortController().signal),
    ]);
    assert.deepEqual(await Promise.all([samplesOf(a), samplesOf(b)]), [
      2 * SAMPLES_PER_CHAR,
      3 * SAMPLES_PER_CHAR,
    ]);

    const started = s.events('tts.started');
    assert.equal(started.length, 1);
    assert.equal((started[0]?.data as { sampleRate?: number } | undefined)?.sampleRate, 16_000);
  } finally {
    await s.close();
  }
});

test('跨进程链路：tts.synthesize 带 traceparent，sidecar 在同一 trace 下把 span 写进宿主给的目录', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bellis-tts-telemetry-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const s = await setup({ sampleRate: 16_000, aligned: true }, undefined, dataDir);
  try {
    const engine = s.engine() as TtsEngine;
    await waitUntil(() => engine.ready);
    const found = s.kernel.services.resolve(TelemetryService.name, TelemetryService.major);
    assert.ok(!('missing' in found));
    const span = (found.impl as Telemetry).tracer('test').startSpan('tts.synthesize');
    const traceparent = span.traceparent as string;
    const synthesis = await engine.synthesize('你好', new AbortController().signal, {
      traceparent,
    });
    assert.equal(await samplesOf(synthesis), 2 * SAMPLES_PER_CHAR);
    span.end();

    const dir = join(dataDir, 'telemetry');
    // 目录在第一次写时才创建。
    const sidecarLines = () =>
      (existsSync(dir) ? readdirSync(dir) : [])
        .filter((name) => name.startsWith('sidecar.tts-local-'))
        .flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n'))
        .filter(Boolean);
    await waitUntil(() =>
      parseLines(sidecarLines()).spans.some((s) => s.name === 'tts_local.align'),
    );
    const lines = sidecarLines();
    for (const line of lines) assert.deepEqual(otlpLineProblems(line), []);
    assert.ok(!lines.join('\n').includes('你好'), 'sidecar 不写朗读文本');
    const view = parseLines(lines);
    const [, traceId, spanId] = traceparent.split('-');
    const server = view.spans.find((s) => s.name === 'tts_local.synthesize');
    assert.equal(server?.traceId, traceId);
    assert.equal(server?.parentSpanId, spanId);
    assert.equal(server?.service, 'bellis.sidecar.tts-local');
    assert.equal(server?.attributes['bellis.tts.samples'], 2 * SAMPLES_PER_CHAR);
    const align = view.spans.find((s) => s.name === 'tts_local.align');
    assert.equal(align?.parentSpanId, server?.spanId);
  } finally {
    await s.close();
  }
});

test('两段式对齐：句段一到即插值，强制对齐的时间戳到达后细化，流结束后有实际总采样数', async () => {
  const s = await setup({ sampleRate: 16_000, aligned: true });
  try {
    const engine = s.engine() as TtsEngine;
    await waitUntil(() => engine.ready);
    const synthesis = await engine.synthesize('你好呀朋友', new AbortController().signal);
    // 插值：每字 220ms，16kHz 下 3520 个采样。
    assert.deepEqual(
      synthesis.timing?.map((t) => t.sample),
      [0, 3520, 7040, 10_560, 14_080],
    );
    assert.equal(synthesis.totalSamples, undefined);
    assert.equal(await samplesOf(synthesis), 5 * SAMPLES_PER_CHAR);
    // 细化：假后端给出每字 1600 个采样的精确时间戳。
    assert.deepEqual(
      synthesis.timing?.map((t) => t.sample),
      [0, 1600, 3200, 4800, 6400],
    );
    assert.equal(synthesis.totalSamples, 5 * SAMPLES_PER_CHAR);
  } finally {
    await s.close();
  }
});

test('中止或停止读取时经 rpc.cancel 停止 sidecar 中的生成', async () => {
  const s = await setup({ chunkDelayMs: 50 });
  try {
    const engine = s.engine() as TtsEngine;
    await waitUntil(() => engine.ready);
    const text = '这是一句需要合成很久的比较长的测试句子';
    const full = [...text].length * SAMPLES_PER_CHAR;

    // 调用方中止：流安静结束，只拿到一部分音频。
    const abort = new AbortController();
    const synthesis = await engine.synthesize(text, abort.signal);
    let received = 0;
    for await (const frame of synthesis.frames) {
      received += frame.length;
      if (received >= 2 * CHUNK_SAMPLES) abort.abort(new Error('测试中止'));
    }
    assert.ok(received < full);
    assert.equal(synthesis.totalSamples, undefined);

    // sidecar 一次只合成一句：前一句若没有真正停止，下一句要排队约 2 秒。
    const started = performance.now();
    const next = await engine.synthesize('好', new AbortController().signal);
    assert.equal(await samplesOf(next), SAMPLES_PER_CHAR);
    assert.ok(performance.now() - started < 1000, '取消没有停止 sidecar 中的生成');

    // 消费方停止读取（Stage 截断）：同样取消。
    const dropped = await engine.synthesize(text, new AbortController().signal);
    for await (const _ of dropped.frames) break;
    const again = performance.now();
    assert.equal(
      await samplesOf(await engine.synthesize('好', new AbortController().signal)),
      SAMPLES_PER_CHAR,
    );
    assert.ok(performance.now() - again < 1000, '停止读取没有取消合成');
    assert.equal(s.state('tts-local').state, 'active');
  } finally {
    await s.close();
  }
});

test('sidecar 崩溃：本地引擎被撤回、记入降级事件，tts@1 不消失、路由改为只出字幕；重启后恢复，派生的进程随之退出', async () => {
  const s = await setup({ crashOn: ['崩溃'], workers: 1, chunkDelayMs: 10 }, [
    'local',
    'subtitles',
  ]);
  try {
    const [first] = s.ready();
    assert.ok(first);
    const worker = first.processes[0] as number;
    assert.equal(first.processes.length, 1);
    assert.ok(isAlive(worker));
    await waitUntil(() => s.engine()?.ready === true);

    const tts = s.users[0] as Tts;
    const synthesis = await tts.synthesize('这句话会让它崩溃掉', new AbortController().signal);
    let received = 0;
    await assert.rejects(async () => {
      for await (const frame of synthesis.frames) received += frame.length;
    });
    assert.ok(received > 0, '崩溃前送出的音频应已到达');

    // 本地引擎不在时，tts@1 仍在：这一句只出字幕（静音帧，按估计时长）。
    await waitUntil(() => s.engine() === undefined);
    assert.equal(s.state('tts').state, 'active');
    assert.equal(s.state('user').state, 'active');
    const subtitles = await tts.synthesize('先出字幕', new AbortController().signal);
    assert.equal(subtitles.sampleRate, 16_000);
    assert.ok((await samplesOf(subtitles)) > 0);

    await waitUntil(() => s.ready().length >= 2 && s.engine()?.ready === true, 30_000);
    assert.equal(
      s.transitions.some((t) => t.entryId === 'user' && t.to === 'waiting'),
      false,
      '依赖 tts@1 的一方不因本地引擎崩溃而停用',
    );
    assert.ok(s.transitions.some((t) => t.entryId === 'tts-local' && t.to === 'failed'));
    const degraded = s.events('tts.degraded');
    assert.equal(degraded.length, 1);
    assert.match(String((degraded[0]?.data as { reason?: string } | undefined)?.reason), /sidecar/);
    assert.equal(s.events('tts.started').length, 2);

    const second = s.ready()[1] as Ready;
    assert.notEqual(second.pid, first.pid);
    await waitUntil(() => !isAlive(first.pid) && !isAlive(worker));

    assert.equal(
      await samplesOf(await tts.synthesize('恢复了', new AbortController().signal)),
      3 * SAMPLES_PER_CHAR,
    );
    const switched = s.events('tts.switched').map((e) => e.data as Record<string, unknown>);
    assert.deepEqual(
      switched.map((d) => [d.from, d.to]),
      [
        ['local', 'subtitles'],
        ['subtitles', 'local'],
      ],
    );
    assert.equal(switched[1]?.reason, 'local 恢复可用');
  } finally {
    await s.close();
  }
});

test('模型加载失败：引擎报告原因并记入降级事件，路由的主引擎未就绪', async () => {
  const s = await setup({ loadError: '显存不足' }, ['local', 'subtitles']);
  try {
    await waitUntil(() => s.events('tts.degraded').length > 0);
    const engine = s.engine() as TtsEngine;
    assert.equal(engine.ready, false);
    assert.equal(engine.status, '模型加载失败：显存不足');
    const { qos, ...primary } = s.routing()?.primary() ?? {};
    assert.deepEqual(primary, { engine: 'local', ready: false, status: '模型加载失败：显存不足' });
    assert.equal(typeof qos, 'function');
    assert.equal(s.state('tts-local').state, 'active');
  } finally {
    await s.close();
  }
});

test('节流状态：sidecar 在 Windows 上启动时声明 HighQoS，经健康检查读回，路由的主引擎带上读回函数', async () => {
  const s = await setup({}, ['local', 'subtitles']);
  try {
    // Windows 上读回 HighQoS；其它平台没有这项设置。两者都不在状态说明里附注。
    const expected = process.platform === 'win32' ? 'high' : 'unsupported';
    assert.equal(s.ready()[0]?.qos, expected);
    const engine = s.engine() as TtsEngine;
    await waitUntil(() => engine.ready);
    assert.equal(engine.status, '就绪');
    assert.equal(await engine.qos?.(), expected);
    assert.equal(await s.routing()?.primary()?.qos?.(), expected);
  } finally {
    await s.close();
  }
});

test('停用时按 R-06 的顺序停止 sidecar：应答 shutdown 后退出，派生的进程随之退出', async () => {
  const s = await setup({ workers: 1 });
  try {
    const [ready] = s.ready();
    assert.ok(ready);
    await s.kernel.disable('tts-local');
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

test('示例 profile：本地 TTS 用真实后端并选定音色，路由按 local、subtitles，配置符合清单', () => {
  const path = fileURLToPath(
    new URL('../../../config/profiles/live.example.json', import.meta.url),
  );
  const entries = resolveProfile(readJsonFile(path), []);
  const local = entries.find((e) => e.plugin === 'tts-local');
  assert.ok(local);
  assert.equal(local.disabled, false);
  const config = Value.Default(LocalTtsConfig, structuredClone(local.config));
  assert.ok(Compile(LocalTtsConfig).Check(config));
  const args = sidecarArgs(config as LocalTtsConfig);
  assert.ok(Array.isArray(args), JSON.stringify(args));
  assert.equal((config as LocalTtsConfig).backend, 'qwen3');

  const router = entries.find((e) => e.plugin === 'tts-router');
  assert.ok(router);
  assert.deepEqual((router.config as { order: string[] }).order, ['local', 'subtitles']);
  assert.ok(
    Compile(ttsRouter.manifest.config).Check(
      Value.Default(ttsRouter.manifest.config, structuredClone(router.config)),
    ),
  );
  assert.equal(entries.find((e) => e.plugin === 'tts-cloud')?.disabled, true);
});

test('qwen3 后端须选定音色；按平台定位 uv 工作区虚拟环境里的解释器', () => {
  const config = Value.Default(LocalTtsConfig, { backend: 'qwen3' }) as LocalTtsConfig;
  assert.deepEqual(sidecarArgs(config), { error: 'qwen3 后端未配置音色（speaker）' });
  assert.match(venvPython('root', 'win32'), /\.venv[\\/]Scripts[\\/]python\.exe$/);
  assert.match(venvPython('root', 'linux'), /\.venv[\\/]bin[\\/]python$/);
});

test('qwen3 后端缺省修剪句首句尾静音，门限与余量传给 sidecar；可以关掉', () => {
  const config = Value.Default(LocalTtsConfig, {
    backend: 'qwen3',
    qwen3: { speaker: 'vivian' },
  }) as LocalTtsConfig;
  const args = sidecarArgs(config) as string[];
  assert.ok(args.includes('--trim-threshold-dbfs=-55'));
  assert.equal(args[args.indexOf('--trim-margin-ms') + 1], '30');
  assert.ok(!args.includes('--no-trim'));
  const off = sidecarArgs({ ...config, qwen3: { ...config.qwen3, trimSilence: false } });
  assert.ok((off as string[]).includes('--no-trim'));
});
