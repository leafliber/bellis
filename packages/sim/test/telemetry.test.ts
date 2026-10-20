import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Llm, LlmService } from '@bellis/director';
import { ClockService, definePlugin } from '@bellis/kernel';
import { builtinPlugins } from '@bellis/plugins';
import {
  formatTrace,
  Metric,
  parseLines,
  type TelemetryMemory,
  TelemetryMemoryService,
  type ViewSpan,
} from '@bellis/telemetry';
import fc from 'fast-check';
import Type from 'typebox';
import { checkHistory, type Scenario, scenarioArbitrary, simulate, World } from '../src/index.ts';
import { chain, entry, played, speak, startChain } from './helpers.ts';

function lines(world: World): readonly string[] {
  return world.service<TelemetryMemory>(TelemetryMemoryService).lines;
}

const named = (spans: readonly ViewSpan[], name: string) => spans.filter((s) => s.name === name);

test('一条弹幕从接入到播出在同一个 trace 里：接入 → 分诊 → 模型调用 → 发言 → 每句的检查、授权、合成与播出', async () => {
  const world = await startChain({
    telemetry: true,
    messages: [
      // d1 一到就交给模型；模型调用期间 d2、d3 同时到达，内容相同，合并成一个候选（d3 以 link 关联）。
      { atMs: 0, id: 'd1', viewer: 'v1', nickname: '小明', text: '主播你好' },
      { atMs: 5, id: 'd2', viewer: 'v2', nickname: '小红', text: '今天玩什么' },
      { atMs: 5, id: 'd3', viewer: 'v3', nickname: '小刚', text: '今天玩什么' },
    ],
    outputs: [
      '{"action":"silence","reason":"先不说"}',
      speak('谢谢你来！今天我们一起玩魔女审判。', 'c-d2'),
    ],
    moderation: { enabled: true, delayMs: 30 },
  });
  try {
    await world.until(() => played(world).length === 1);
    await world.run(100);
    const view = parseLines(lines(world));
    const root = named(view.spans, 'danmaku.receive').find(
      (s) => s.attributes['bellis.danmaku.id'] === 'd2',
    );
    assert.ok(root, '有 d2 的根 span');
    const trace = view.spans.filter((s) => s.traceId === root.traceId);
    const byId = new Map(trace.map((s) => [s.spanId, s]));
    const parentName = (span: ViewSpan) =>
      span.parentSpanId === undefined ? undefined : byId.get(span.parentSpanId)?.name;

    const [candidate] = named(trace, 'triage.candidate');
    assert.equal(candidate?.parentSpanId, root.spanId);
    assert.equal(candidate?.attributes['bellis.triage.outcome'], 'taken');
    assert.equal(candidate?.attributes['bellis.triage.merged'], 2);
    const d3 = named(view.spans, 'danmaku.receive').find(
      (s) => s.attributes['bellis.danmaku.id'] === 'd3',
    );
    assert.notEqual(d3?.traceId, root.traceId, '合并进来的弹幕各有自己的 trace');
    assert.deepEqual(candidate?.links, [{ traceId: d3?.traceId, spanId: d3?.spanId }]);

    const [call] = named(trace, 'chat replay');
    assert.equal(parentName(call as ViewSpan), 'triage.candidate');
    assert.equal(call?.attributes['gen_ai.operation.name'], 'chat');
    assert.equal(call?.attributes['gen_ai.provider.name'], 'bellis.replay');
    assert.equal(call?.attributes['gen_ai.request.model'], 'replay');

    const [utterance] = named(trace, 'speech.utterance');
    assert.equal(parentName(utterance as ViewSpan), 'triage.candidate');
    assert.deepEqual(utterance?.links, [{ traceId: call?.traceId, spanId: call?.spanId }]);
    assert.equal(utterance?.attributes['bellis.speech.source'], 'danmaku-reply');
    assert.equal(utterance?.attributes['bellis.speech.end'], 'complete');

    const sentences = named(trace, 'speech.sentence');
    assert.equal(sentences.length, 2);
    for (const sentence of sentences) {
      assert.equal(sentence.parentSpanId, utterance?.spanId);
      assert.equal(sentence.attributes['bellis.speech.sentence_fate'], 'played');
      const children = trace.filter((s) => s.parentSpanId === sentence.spanId).map((s) => s.name);
      assert.deepEqual(children.sort(), [
        'speech.authorize',
        'speech.pre_check',
        'stage.play',
        'tts.synthesize',
      ]);
      const check = trace.find(
        (s) => s.name === 'speech.pre_check' && s.parentSpanId === sentence.spanId,
      );
      const moderation = trace.find((s) => s.parentSpanId === check?.spanId);
      assert.equal(moderation?.name, 'moderation.check');
      assert.equal(moderation?.attributes['bellis.moderation.outcome'], 'allow');
      const stage = trace.find(
        (s) => s.name === 'stage.play' && s.parentSpanId === sentence.spanId,
      );
      assert.deepEqual(
        stage?.events.map((e) => e.name),
        ['bellis.stage.started'],
      );
      assert.equal(stage?.attributes['bellis.stage.complete'], true);
    }

    for (const name of [
      Metric.DanmakuFirstAudio,
      Metric.DanmakuFirstAudioPresented,
      Metric.TtsFirstAudio,
      Metric.ModerationDuration,
      Metric.LeaseRenewLag,
      'gen_ai.client.operation.duration',
    ]) {
      assert.ok((view.metrics.get(`${name} s`)?.values.length ?? 0) > 0, `${name} 有样本`);
    }
    // 审核每句耗时 30ms（模拟模型的延迟）。
    assert.deepEqual(view.metrics.get(`${Metric.ModerationDuration} s`)?.values, [0.03, 0.03]);

    const tree = formatTrace(view, root.traceId);
    assert.ok(tree.includes('danmaku.receive'));
    assert.ok(!tree.includes('主播你好') && !tree.includes('小明') && !tree.includes('谢谢你来'));

    assert.deepEqual(
      checkHistory({
        trace: world.trace,
        events: world.events(),
        moderationEnabled: true,
        telemetry: lines(world),
      }),
      [],
    );
  } finally {
    await world.close();
  }
});

/** 报用量的模型客户端：第一次调用回应 c-d1 并报 token 数，之后不再应答（超时）。 */
const usageLlm = definePlugin({
  manifest: {
    id: 'llm-usage',
    version: '1.0.0',
    tier: 'ordinary',
    provides: [LlmService.ref],
    inject: [ClockService.ref],
    permissions: [],
    process: 'in-process',
    config: Type.Object({}),
  },
  activate(ctx) {
    const clock = ctx.service(ClockService);
    let calls = 0;
    const llm: Llm = {
      model: { provider: 'test', name: 'test-model' },
      complete(_request, _signal, options) {
        calls += 1;
        if (calls > 1) return new Promise(() => {});
        options?.onUsage?.({ inputTokens: 120, outputTokens: 30, responseModel: 'test-model-1' });
        return new Promise((resolve) =>
          clock.setTimeout(() => resolve(speak('好的。', 'c-d1')), 200),
        );
      },
    };
    ctx.provide(LlmService, llm);
  },
});

test('模型调用的 GenAI span：型号、用量与耗时；超时记 error.type，不记上下文与输出', async () => {
  const entries = chain({
    telemetry: true,
    messages: [
      { atMs: 0, id: 'd1', viewer: 'v1', nickname: '小明', text: '主播你好' },
      { atMs: 1000, id: 'd2', viewer: 'v2', nickname: '小红', text: '在吗' },
    ],
  }).map((e) => (e.id === 'llm' ? entry('llm', 'llm-usage') : e));
  const world = new World({
    entries,
    moderationEnabled: true,
    plugins: new Map([...builtinPlugins, [usageLlm.manifest.id, usageLlm]]),
  });
  await world.kernel.settled();
  assert.ok(world.safety.requestMode('M0').ok);
  try {
    await world.until(() => played(world).length === 1);
    await world.run(9_000);
    const view = parseLines(lines(world));
    const calls = named(view.spans, 'chat test-model');
    assert.equal(calls.length, 2);
    const [ok, timedOut] = calls;
    assert.deepEqual(ok?.attributes, {
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'test',
      'gen_ai.request.model': 'test-model',
      'bellis.director.candidates': 1,
      'gen_ai.usage.input_tokens': 120,
      'gen_ai.usage.output_tokens': 30,
      'gen_ai.response.model': 'test-model-1',
      'bellis.director.action': 'speak',
    });
    assert.equal(timedOut?.error, true);
    assert.equal(timedOut?.attributes['error.type'], 'timeout');
    assert.deepEqual(view.metrics.get('gen_ai.client.token.usage {token}')?.values, [120, 30]);
    assert.deepEqual(view.metrics.get('gen_ai.client.operation.duration s')?.values, [0.2, 8]);
    assert.ok(!lines(world).join('\n').includes('主播你好'));
  } finally {
    await world.close();
  }
});

test('遥测只是观察：同一场景启用与不启用遥测，仿真追踪与事件完全相同', async () => {
  await fc.assert(
    fc.asyncProperty(scenarioArbitrary(10_000), async (scenario: Scenario) => {
      const without = await simulate(scenario, { drainMs: 5_000, telemetry: false });
      const withTelemetry = await simulate(scenario, { drainMs: 5_000 });
      assert.deepEqual(withTelemetry.violations, []);
      assert.deepEqual(withTelemetry.history.trace, without.history.trace);
      assert.deepEqual(withTelemetry.history.events, without.history.events);
      assert.equal(without.history.telemetry, undefined);
      assert.ok((withTelemetry.history.telemetry?.length ?? 0) > 0);
    }),
    { seed: 11, numRuns: 5 },
  );
});
