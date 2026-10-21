import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ManualClock, readJsonFile, resolveProfile, seededRandom } from '@bellis/kernel';
import Value from 'typebox/value';
import {
  formatSummary,
  formatTrace,
  MemoryWriter,
  parseLines,
  percentile,
  TelemetryConfig,
  TelemetryCore,
} from '../src/index.ts';
import { telemetryDir } from '../src/locate.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('分位数按最近秩法：第 ⌈q·n⌉ 个', () => {
  const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(sorted, 0.5), 50);
  assert.equal(percentile(sorted, 0.95), 95);
  assert.equal(percentile(sorted, 0.99), 99);
  assert.equal(percentile([7], 0.99), 7);
  assert.equal(percentile([1, 2, 3], 0.5), 2);
  assert.equal(percentile([], 0.5), undefined);
});

async function sample() {
  const clock = new ManualClock(0, undefined, Date.UTC(2026, 9, 21));
  const writer = new MemoryWriter();
  const core = new TelemetryCore({
    clock,
    random: seededRandom(5),
    resource: { 'service.name': 'bellis.host' },
    writer,
    maxQueue: 1000,
    batchSize: 1000,
    flushIntervalMs: 0,
  });
  const tracer = core.tracer('t');
  const receive = tracer.startSpan('danmaku.receive', {
    attributes: { 'bellis.danmaku.id': 'd1' },
  });
  receive.end();
  clock.advance(5);
  const candidate = tracer.startSpan('triage.candidate', { parent: receive });
  clock.advance(1200);
  candidate.end();
  const play = tracer.startSpan('stage.play', { parent: candidate });
  clock.advance(10);
  play.addEvent('bellis.stage.started');
  play.fail('stage_unavailable');
  play.end();
  for (let i = 1; i <= 20; i += 1) tracer.record('bellis.tts.time_to_first_audio', i / 100, 's');
  tracer.record('bellis.test.count', 300, '{item}');
  await new Promise((r) => setImmediate(r));
  return { lines: writer.lines, traceId: (receive.traceparent as string).slice(3, 35) };
}

test('汇总：各直方图的样本数与 p50/p95/p99，最近的弹幕链路', async () => {
  const { lines, traceId } = await sample();
  const view = parseLines([...lines, '不是 JSON', '{"other":1}', '']);
  assert.equal(view.invalid, 2);
  const text = formatSummary(view);
  assert.match(
    text,
    /bellis\.tts\.time_to_first_audio {2}n=20 {2}p50 100\.0ms {2}p95 190\.0ms {2}p99 200\.0ms/,
  );
  // 不是秒的单位按原值与单位显示。
  assert.match(text, /bellis\.test\.count {2}n=1 {2}p50 300\{item\}/);
  assert.ok(text.includes(traceId));
});

test('按 trace 打印 span 树：父子缩进、相对时刻、耗时、事件与出错', async () => {
  const { lines, traceId } = await sample();
  const view = parseLines(lines);
  const tree = formatTrace(view, traceId.slice(0, 8)).split('\n');
  assert.match(tree[0] as string, new RegExp(`^trace ${traceId}（3 个 span`));
  assert.match(
    tree[1] as string,
    /^danmaku\.receive {2}\[bellis\.host\] {2}\+0\.0ms {2}0\.0ms {2}bellis\.danmaku\.id=d1$/,
  );
  assert.match(
    tree[2] as string,
    /^ {2}triage\.candidate {2}\[bellis\.host\] {2}\+5\.0ms {2}1200\.0ms$/,
  );
  assert.match(
    tree[3] as string,
    /^ {4}stage\.play .*\+1205\.0ms {2}10\.0ms {2}ERROR {2}error\.type=stage_unavailable$/,
  );
  assert.equal(tree[4], '      · bellis.stage.started +1215.0ms');
  assert.match(formatTrace(view, 'zz'), /不合格/);
  assert.match(formatTrace(view, 'ffffffff'), /没有找到/);
});

test('仓库自带的 profile 都启用遥测，配置合格；目录在状态存储所在目录下，sim 与 live 分开', () => {
  const dirs = new Set<string>();
  for (const [config, profile] of [
    ['sim.json', 'sim.json'],
    ['live.example.json', 'live.example.json'],
  ] as const) {
    const path = join(root, 'config', 'profiles', profile);
    const found = resolveProfile(readJsonFile(path), []).find((e) => e.plugin === 'telemetry');
    assert.ok(found, profile);
    assert.equal(found.disabled, false);
    assert.ok(
      Value.Check(TelemetryConfig, Value.Default(TelemetryConfig, structuredClone(found.config))),
    );
    if (config === 'sim.json') {
      const dir = telemetryDir(join(root, 'config', config));
      assert.equal(dir, resolve(root, '.bellis', 'telemetry', 'sim'));
      dirs.add(dir);
    }
    dirs.add(String((found.config as { dir: string }).dir));
  }
  assert.equal(dirs.size, 3);
});
