import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Alignment, speakable, subtitleStarts } from '@bellis/speech';
import { checkHistory, SAMPLES_PER_CHAR, type TraceEntry, World } from '../src/index.ts';
import { chain, entry, played, startChain } from './helpers.ts';

/** 页面每次显示变化的文本，以及当时这一句已播出的采样数（由 page.played 累计）。 */
function subtitles(trace: readonly TraceEntry[], sentenceId: string) {
  let samples = 0;
  const shown: Array<{ text: string; played: number }> = [];
  for (const entry of trace) {
    if (entry.data.sentenceId !== sentenceId) continue;
    if (entry.kind === 'page.played') samples += Number(entry.data.samples);
    if (entry.kind === 'page.subtitle')
      shown.push({ text: String(entry.data.text), played: samples });
  }
  return shown;
}

const clean = (world: World) =>
  checkHistory({ trace: world.trace, events: world.events(), moderationEnabled: true });

test('字幕随游标逐字推进：显示的字都已开始播出，播完即清除', async () => {
  const world = await startChain({
    announcements: [{ id: 'hello', atMs: 0, text: '你好世界。' }],
    tts: { samplesPerChar: SAMPLES_PER_CHAR },
  });
  try {
    await world.until(() => played(world).length === 1);
    assert.deepEqual(
      subtitles(world.trace, 'scheduled:hello#0').map((s) => s.text),
      ['你', '你好', '你好世', '你好世界', '你好世界。', ''],
    );
    assert.deepEqual(clean(world), []);
  } finally {
    await world.close();
  }
});

test('两段式映射且 TTS 比实时慢：页面反复欠载，字幕仍不早于游标', async () => {
  const world = await startChain({
    announcements: [{ id: 'slow', atMs: 0, text: '慢一点说，大家好。' }],
    // 插值按每字 60ms 估计，实际每字 100ms；音频产生得比播放慢一倍。
    tts: { samplesPerChar: SAMPLES_PER_CHAR, twoStage: true, estimateMsPerChar: 60, slowness: 2 },
  });
  try {
    await world.until(() => played(world).length === 1);
    assert.ok(world.logs.some((l) => l.event === 'stage.underrun'));
    const texts = subtitles(world.trace, 'scheduled:slow#0').map((s) => s.text);
    assert.deepEqual(texts.slice(-2), ['慢一点说，', '']);
    assert.ok(texts.length >= 6, '逐字显示');
    assert.deepEqual(clean(world), []);
  } finally {
    await world.close();
  }
});

test('只出字幕：TTS 路由给出插值映射，字幕按静音帧的播放进度逐字推进', async () => {
  const entries = chain({ announcements: [{ id: 'quiet', atMs: 0, text: '今天先聊天。' }] }).map(
    (e) => (e.id === 'tts' ? entry('tts', 'tts-router', { config: { order: ['subtitles'] } }) : e),
  );
  const world = new World({ entries, moderationEnabled: true });
  try {
    await world.kernel.settled();
    assert.ok(world.safety.requestMode('M0').ok);
    await world.until(() => played(world).length === 1);
    assert.equal(played(world)[0]?.heard, '今天先聊天。');
    // 路由按每字 220ms、16kHz 插值，并已按估计的总采样数修正。
    const subtitle = '今天先聊天。';
    const { spoken, align } = speakable(subtitle);
    const alignment = new Alignment(spoken, 16_000, { msPerChar: 220 });
    alignment.complete(alignment.estimatedSamples);
    const starts = subtitleStarts({ index: 0, subtitle, spoken, align }, alignment.timing) ?? [];
    const shown = subtitles(world.trace, 'scheduled:quiet#0');
    assert.deepEqual(
      shown.map((s) => s.text),
      ['今', '今天', '今天先', '今天先聊', '今天先聊天', '今天先聊天。', ''],
    );
    for (const { text, played } of shown.slice(0, -1)) {
      assert.equal([...text].length, starts.filter((start) => start <= played).length, text);
    }
  } finally {
    await world.close();
  }
});

test('急停：页面回报截断之前字幕已清除，之后不再显示', async () => {
  const world = await startChain({
    announcements: [{ id: 'long', atMs: 0, text: '这是一句比较长的定时播报，会被急停打断。' }],
    tts: { samplesPerChar: SAMPLES_PER_CHAR },
  });
  try {
    await world.run(800);
    const shownBefore = subtitles(world.trace, 'scheduled:long#0').at(-1)?.text ?? '';
    assert.ok(shownBefore.length > 1, `急停前已逐字显示：${shownBefore}`);
    void world.safety.emergencyStop('操作员急停');
    await world.until(() => played(world).length === 1);
    await world.run(1000);
    const kinds = world.trace
      .filter((e) => e.data.sentenceId === 'scheduled:long#0')
      .map((e) => (e.kind === 'page.subtitle' ? `subtitle:${String(e.data.text)}` : e.kind));
    const cut = kinds.indexOf('page.truncated');
    assert.ok(cut > 0);
    assert.equal(kinds[cut - 1], 'subtitle:', '截断回报之前刚清除');
    assert.ok(!kinds.slice(cut).some((k) => k.startsWith('subtitle:')), '之后不再显示');
    assert.deepEqual(clean(world), []);
  } finally {
    await world.close();
  }
});

test('不变量：字幕超前于游标、版面没有固定、播完时没有清除，都被报告', () => {
  let seq = 0;
  const at = (kind: string, data: Record<string, unknown>): TraceEntry => ({
    seq: seq++,
    at: 0,
    kind,
    data,
  });
  const trace = [
    at('world.start', {}),
    at('control.mode', { mode: 'M0' }),
    at('page.begin', { sentenceId: 'u#0', subtitle: '你好', token: 1 }),
    at('page.played', { sentenceId: 'u#0', token: 1, samples: 320 }),
    at('page.subtitle', { sentenceId: 'u#0', text: '你好', hidden: '' }),
    // 占位缺了一段：版面没有从一开始固定。
    at('page.subtitle', { sentenceId: 'u#0', text: '你', hidden: '' }),
    at('page.ended', { sentenceId: 'u#0', played: 3200 }),
  ];
  const violations = checkHistory({ trace, events: [], moderationEnabled: false });
  assert.equal(violations.length, 3, violations.join('\n'));
  assert.match(violations[0] ?? '', /最后一个字从第 1600 个采样才开始/);
  assert.match(violations[1] ?? '', /拼起来不是整句“你好”/);
  assert.match(violations[2] ?? '', /播完或截断时字幕没有清除/);
});
