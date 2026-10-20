import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ManualClock, seededRandom } from '@bellis/kernel';
import {
  MemoryWriter,
  type OtlpMetrics,
  type OtlpTraces,
  otlpLineProblems,
  parseTraceparent,
  TelemetryCore,
  type TelemetryCoreOptions,
  type TelemetryWriter,
} from '../src/index.ts';

const EPOCH = Date.UTC(2026, 9, 21);

function core(options: Partial<TelemetryCoreOptions> = {}) {
  const clock = options.clock ?? new ManualClock(0, undefined, EPOCH);
  const writer = new MemoryWriter();
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const telemetry = new TelemetryCore({
    clock,
    random: seededRandom(1),
    resource: { 'service.name': 'bellis.host' },
    writer,
    maxQueue: 100,
    batchSize: 100,
    flushIntervalMs: 0,
    log: (event, fields) => logs.push({ event, fields }),
    ...options,
  });
  return { telemetry, writer, logs, clock: clock as ManualClock };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function spansOf(lines: readonly string[]) {
  return lines
    .map((line) => JSON.parse(line) as Partial<OtlpTraces>)
    .flatMap((request) => request.resourceSpans ?? [])
    .flatMap((resource) => resource.scopeSpans)
    .flatMap((scoped) => scoped.spans.map((span) => ({ scope: scoped.scope.name, ...span })));
}

function metricsOf(lines: readonly string[]) {
  return lines
    .map((line) => JSON.parse(line) as Partial<OtlpMetrics>)
    .flatMap((request) => request.resourceMetrics ?? [])
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scoped) => scoped.metrics);
}

test('span：父子同一 trace、根开新 trace、按 traceparent 接上跨进程的父，时间戳是 Unix 纳秒', async () => {
  const { telemetry, writer, clock } = core();
  const tracer = telemetry.tracer('speech-arbiter');
  clock.advance(1.5);
  const root = tracer.startSpan('speech.utterance', {
    attributes: { 'bellis.speech.source': 'chatter' },
  });
  const child = tracer.startSpan('speech.sentence', { parent: root, kind: 'internal' });
  clock.advance(10);
  child.end();
  root.end();
  const remote = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  tracer.startSpan('tts_local.synthesize', { parent: remote, kind: 'server' }).end();
  tracer.startSpan('orphan', { parent: 'not-a-traceparent' }).end();
  await tick();

  for (const line of writer.lines) assert.deepEqual(otlpLineProblems(line), []);
  const spans = spansOf(writer.lines);
  const [sentence, utterance, server, orphan] = spans;
  assert.equal(sentence?.scope, 'speech-arbiter');
  assert.equal(sentence?.traceId, utterance?.traceId);
  assert.equal(sentence?.parentSpanId, utterance?.spanId);
  assert.equal(utterance?.parentSpanId, undefined);
  assert.equal(root.traceparent, `00-${utterance?.traceId}-${utterance?.spanId}-01`);
  assert.equal(BigInt(utterance?.startTimeUnixNano ?? 0), BigInt(EPOCH) * 1_000_000n + 1_500_000n);
  assert.equal(
    BigInt(utterance?.endTimeUnixNano ?? 0) - BigInt(utterance?.startTimeUnixNano ?? 0),
    10_000_000n,
  );
  assert.equal(server?.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(server?.parentSpanId, '00f067aa0ba902b7');
  assert.equal(server?.kind, 2);
  // 父上下文不合格：开新 trace，不抛错。
  assert.equal(orphan?.parentSpanId, undefined);
  assert.notEqual(orphan?.traceId, utterance?.traceId);
});

test('span：links、事件、出错状态、不合格的属性与名字被拒绝并计数，结束后不再变化', async () => {
  const { telemetry, writer, clock } = core();
  const tracer = telemetry.tracer('audience-triage');
  const a = tracer.startSpan('danmaku.receive');
  const b = tracer.startSpan('danmaku.receive');
  a.end();
  b.end();
  const span = tracer.startSpan('triage.candidate', {
    parent: a,
    links: [undefined, 'garbage'],
    attributes: {
      'bellis.triage.candidate_id': 'c-d1',
      'bellis.danmaku.text': '主播你好',
      'bellis.danmaku.nickname': 'Viewer_1',
      'bellis.note': '中文内容',
    },
  });
  span.addLink(b);
  span.addLink({ traceparent: a.traceparent as string });
  clock.advance(5);
  span.addEvent('bellis.triage.merged', { 'bellis.triage.count': 2, 'bellis.danmaku.text': 'x' });
  span.addEvent('不合格的事件名');
  span.fail('timeout');
  span.end();
  span.setAttributes({ 'bellis.after': true });
  span.addEvent('bellis.after');
  span.end();
  await tick();

  const spans = spansOf(writer.lines);
  assert.equal(spans.length, 3);
  const candidate = spans[2];
  assert.deepEqual(candidate?.attributes, [
    { key: 'bellis.triage.candidate_id', value: { stringValue: 'c-d1' } },
    { key: 'error.type', value: { stringValue: 'timeout' } },
  ]);
  assert.equal(candidate?.droppedAttributesCount, 3);
  assert.deepEqual(candidate?.status, { code: 2 });
  const linked = [b, a].map((s) => parseTraceparent(s.traceparent));
  assert.deepEqual(
    candidate?.links,
    linked.map((c) => ({ traceId: c?.traceId, spanId: c?.spanId })),
  );
  assert.deepEqual(candidate?.events, [
    {
      timeUnixNano: String(BigInt(EPOCH) * 1_000_000n + 5_000_000n),
      name: 'bellis.triage.merged',
      attributes: [{ key: 'bellis.triage.count', value: { intValue: '2' } }],
      droppedAttributesCount: 1,
    },
  ]);
  assert.equal(candidate?.droppedEventsCount, 1);
  assert.equal(telemetry.stats().droppedAttributes, 3);
});

test('直方图：同一批里同一指标、同一组属性合成一个增量数据点，每个样本另作 exemplar', async () => {
  const { telemetry, writer, clock } = core({ flushIntervalMs: 1000 });
  const tracer = telemetry.tracer('moderation');
  const span = tracer.startSpan('moderation.check');
  tracer.record(
    'bellis.moderation.check.duration',
    0.02,
    's',
    { 'bellis.moderation.outcome': 'allow' },
    span,
  );
  clock.advance(100);
  tracer.record('bellis.moderation.check.duration', 0.3, 's', {
    'bellis.moderation.outcome': 'allow',
  });
  tracer.record('bellis.moderation.check.duration', 2, 's', {
    'bellis.moderation.outcome': 'error',
  });
  // 不是秒的单位用 SDK 缺省的桶边界。
  tracer.record('bellis.test.count', 30, '{item}', { 'bellis.test.kind': 'a' });
  // 不合格的样本丢弃并计数。
  tracer.record('bad name', 1, 's');
  tracer.record('bellis.x', Number.NaN, 's');
  clock.advance(900);
  await tick();
  span.end();
  await tick();
  assert.equal(writer.lines.length, 1, '1 秒后只写了直方图，span 在下一批');
  for (const line of writer.lines) assert.deepEqual(otlpLineProblems(line), []);
  const [duration, count] = metricsOf(writer.lines);
  assert.equal(duration?.name, 'bellis.moderation.check.duration');
  assert.equal(duration?.unit, 's');
  assert.equal(duration?.histogram.aggregationTemporality, 1);
  const [allow, error] = duration?.histogram.dataPoints ?? [];
  assert.equal(allow?.count, '2');
  assert.equal(allow?.sum, 0.32);
  assert.equal(allow?.min, 0.02);
  assert.equal(allow?.max, 0.3);
  assert.equal(allow?.startTimeUnixNano, String(BigInt(EPOCH) * 1_000_000n));
  assert.equal(allow?.timeUnixNano, String(BigInt(EPOCH) * 1_000_000n + 1_000_000_000n));
  assert.deepEqual(
    allow?.exemplars.map((e) => e.asDouble),
    [0.02, 0.3],
  );
  assert.equal(allow?.exemplars[0]?.spanId, parseTraceparent(span.traceparent)?.spanId);
  assert.equal(allow?.exemplars[1]?.spanId, undefined);
  // 0.02 落在 (0.01, 0.025]，0.3 落在 (0.25, 0.5]。
  assert.equal(allow?.bucketCounts[2], '1');
  assert.equal(allow?.bucketCounts[7], '1');
  assert.equal(error?.count, '1');
  assert.equal(count?.unit, '{item}');
  // 30 落在 (25, 50]。
  assert.equal(count?.histogram.dataPoints[0]?.bucketCounts[4], '1');
  assert.equal(count?.histogram.dataPoints[0]?.explicitBounds[0], 0);
  assert.equal(telemetry.stats().rejectedSamples, 2);
});

test('队列满了丢弃最旧的记录并计数，只记一次日志', async () => {
  const { telemetry, writer, logs } = core({ maxQueue: 3, flushIntervalMs: 1000 });
  const tracer = telemetry.tracer('t');
  for (let i = 0; i < 5; i += 1) tracer.record('bellis.n', i, '1');
  telemetry.flush();
  const values = metricsOf(writer.lines)[0]?.histogram.dataPoints[0]?.exemplars.map(
    (e) => e.asDouble,
  );
  assert.deepEqual(values, [2, 3, 4]);
  assert.equal(telemetry.stats().dropped, 2);
  assert.equal(logs.filter((l) => l.event === 'telemetry.queue-full').length, 1);
});

test('写失败：不抛给调用方，这一批丢弃并计数，只记一次日志；之后照常写', async () => {
  let fail = true;
  const lines: string[] = [];
  const writer: TelemetryWriter = {
    write(chunk) {
      if (fail) return Promise.reject(Object.assign(new Error('磁盘满'), { code: 'ENOSPC' }));
      lines.push(chunk);
      return Promise.resolve();
    },
    close() {},
  };
  const syncThrow: TelemetryWriter = {
    write() {
      throw new Error('同步出错');
    },
    close() {},
  };
  const { telemetry, logs } = core({ writer });
  const tracer = telemetry.tracer('t');
  tracer.startSpan('a').end();
  await tick();
  tracer.startSpan('b').end();
  await tick();
  assert.equal(telemetry.stats().writeFailures, 2);
  assert.equal(telemetry.stats().lost, 2);
  assert.deepEqual(
    logs.filter((l) => l.event === 'telemetry.write-failed').map((l) => l.fields.error),
    ['ENOSPC'],
  );
  fail = false;
  tracer.startSpan('c').end();
  await tick();
  assert.equal(lines.length, 1);
  assert.equal(spansOf(lines.join('').split('\n').filter(Boolean))[0]?.name, 'c');

  const other = core({ writer: syncThrow });
  assert.doesNotThrow(() => other.telemetry.tracer('t').startSpan('x').end());
  await tick();
  assert.equal(other.telemetry.stats().writeFailures, 1);
});

test('同时只有一批在写；停止时写完剩下的再关闭，之后的记录丢弃', async () => {
  const pending: Array<PromiseWithResolvers<void>> = [];
  const chunks: string[] = [];
  let closed = false;
  const writer: TelemetryWriter = {
    write(chunk) {
      chunks.push(chunk);
      const gate = Promise.withResolvers<void>();
      pending.push(gate);
      return gate.promise;
    },
    close() {
      closed = true;
    },
  };
  const { telemetry } = core({ writer, batchSize: 2 });
  const tracer = telemetry.tracer('t');
  for (const name of ['a', 'b', 'c', 'd', 'e']) tracer.startSpan(name).end();
  await tick();
  assert.equal(chunks.length, 1, '第一批还没写完，不写第二批');
  const closing = telemetry.close();
  for (let i = 0; i < 5 && !closed; i += 1) {
    pending.shift()?.resolve();
    await tick();
  }
  await closing;
  assert.equal(closed, true);
  assert.deepEqual(
    spansOf(chunks.join('').split('\n').filter(Boolean)).map((s) => s.name),
    ['a', 'b', 'c', 'd', 'e'],
  );
  tracer.startSpan('late').end();
  tracer.record('bellis.late', 1, 's');
  await tick();
  assert.equal(chunks.length, 3);
});

test('同一种子、同一时钟两次运行写出完全相同的行', async () => {
  const run = async () => {
    const { telemetry, writer, clock } = core();
    const tracer = telemetry.tracer('t');
    const root = tracer.startSpan('root');
    clock.advance(3);
    tracer.startSpan('child', { parent: root }).end();
    tracer.record('bellis.x', 0.5, 's', undefined, root);
    root.end();
    await tick();
    return writer.lines;
  };
  assert.deepEqual(await run(), await run());
});
