import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ClockService,
  catalog,
  DataDirService,
  definePlugin,
  Kernel,
  RandomService,
  type ResolvedEntry,
  seededRandom,
  systemClock,
} from '@bellis/kernel';
import { ChildEnv, SidecarTelemetry } from '@bellis/protocol';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import {
  memoryTelemetry,
  otlpLineProblems,
  parseLines,
  type Span,
  type TelemetryMemory,
  TelemetryMemoryService,
  TelemetryService,
  type Tracer,
  telemetry,
  useTracer,
} from '../src/index.ts';

function entry(id: string, plugin: string, config: unknown = {}): ResolvedEntry {
  return { id, plugin, config, disabled: false, explicitSwitch: false, grant: [] };
}

/** 以可选依赖使用遥测的插件：激活时拿到记录器，测试经它开 span。 */
function user(tracers: Tracer[]) {
  return definePlugin({
    manifest: {
      id: 'user',
      version: '1.0.0',
      tier: 'ordinary',
      provides: [],
      inject: [`${TelemetryService.ref}?`],
      permissions: [],
      process: 'in-process',
      config: Type.Object({}),
    },
    activate(ctx) {
      tracers.push(useTracer(ctx, 'user'));
    },
  });
}

function kernel(dataDir?: string) {
  const host = new Kernel({
    clock: systemClock(),
    safety: { revokeLeases() {}, quiesceTimedOut() {}, inMaintenance: () => false },
  });
  host.provideCore(ClockService, systemClock());
  host.provideCore(RandomService, seededRandom(3));
  if (dataDir) host.provideCore(DataDirService, { path: dataDir });
  return host;
}

test('遥测插件：写进状态存储所在目录下的子目录，给 sidecar 同一目录与轮转规则', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bellis-data-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const tracers: Tracer[] = [];
  const host = kernel(dataDir);
  host.add(
    [
      entry('telemetry', 'telemetry', {
        dir: 'telemetry/sim',
        flushIntervalMs: 50,
        eventLoopIntervalMs: 100,
      }),
      entry('user', 'user'),
    ],
    catalog(telemetry, user(tracers)),
  );
  await host.settled();
  const env = (
    host.services.resolve('telemetry', 1) as { impl: { sidecarEnv(): Record<string, string> } }
  ).impl.sidecarEnv();
  const sidecar = JSON.parse(env[ChildEnv.Telemetry] as string);
  assert.ok(Compile(SidecarTelemetry).Check(sidecar));
  assert.equal(sidecar.dir, join(dataDir, 'telemetry', 'sim'));

  const span = tracers[0]?.startSpan('bellis.test', { attributes: { 'bellis.n': 1 } }) as Span;
  assert.match(span.traceparent ?? '', /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  span.end();
  await new Promise((resolve) => setTimeout(resolve, 450));
  await host.shutdown();

  const dir = join(dataDir, 'telemetry', 'sim');
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0] as string, /^host-\d{8}T\d{9}Z-0\.jsonl$/);
  const lines = readFileSync(join(dir, files[0] as string), 'utf8')
    .split('\n')
    .filter(Boolean);
  for (const line of lines) assert.deepEqual(otlpLineProblems(line), []);
  const view = parseLines(lines);
  assert.deepEqual(
    view.spans.map((s) => [s.name, s.service, s.scope]),
    [['bellis.test', 'bellis.host', 'user']],
  );
  assert.ok(
    (view.metrics.get('bellis.host.event_loop.delay s')?.values.length ?? 0) > 0,
    '事件循环延迟有样本',
  );
});

test('没有遥测插件时使用方照常工作，记录器是空实现；遥测停用后已拿到的记录器也变成空实现', async () => {
  const tracers: Tracer[] = [];
  const host = kernel();
  host.add([entry('user', 'user')], catalog(user(tracers)));
  await host.settled();
  const tracer = tracers[0] as Tracer;
  const span = tracer.startSpan('x');
  assert.equal(span.traceparent, undefined);
  assert.doesNotThrow(() => {
    span.setAttributes({ 'bellis.a': 1 });
    span.addEvent('e');
    span.fail('boom');
    span.end();
    tracer.record('bellis.n', 1, 's');
  });
  await host.shutdown();

  const second: Tracer[] = [];
  const withMemory = kernel();
  withMemory.add(
    [entry('telemetry', 'telemetry-memory'), entry('user', 'user')],
    catalog(memoryTelemetry, user(second)),
  );
  await withMemory.settled();
  const memory = withMemory.services.resolve(
    TelemetryMemoryService.name,
    TelemetryMemoryService.major,
  ) as { impl: TelemetryMemory };
  const live = second[0] as Tracer;
  const open = live.startSpan('before');
  assert.ok(open.traceparent);
  await withMemory.disable('telemetry');
  // 使用方不依赖它（可选依赖），照常 ACTIVE；之后的 span 是空实现，之前开的 span 结束时丢弃。
  assert.equal(withMemory.snapshot().find((e) => e.id === 'user')?.state, 'active');
  assert.equal(live.startSpan('after').traceparent, undefined);
  assert.doesNotThrow(() => open.end());
  await withMemory.shutdown();
  assert.deepEqual(parseLines(memory.impl.lines).spans, []);
});

test('数据目录不在时遥测插件等待；子目录不能跳出数据目录', async () => {
  const host = kernel();
  host.add([entry('telemetry', 'telemetry')], catalog(telemetry));
  await host.settled();
  assert.equal(host.snapshot()[0]?.state, 'waiting');
  assert.match(host.snapshot()[0]?.reason ?? '', /data-dir@1/);
  await host.shutdown();

  for (const dir of ['../escape', '/abs', 'a/../b', 'a\\b', '']) {
    const bad = kernel(tmpdir());
    bad.add([entry('telemetry', 'telemetry', { dir })], catalog(telemetry));
    await bad.settled();
    assert.equal(bad.snapshot()[0]?.state, 'failed', dir);
    await bad.shutdown();
  }
});
