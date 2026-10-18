import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Subtitles, validStarts, visibleCount } from '../page/subtitle.js';
import { WAKE_FRAMES, type Worklet, worklet } from './worklet-scope.ts';

/** 代替页面里的两个字幕元素：每次写出记为“已显示|未显示”。 */
function screen() {
  const writes: string[] = [];
  const parts: Array<[shown: string, hidden: string]> = [];
  const subtitles = new Subtitles((shown, hidden) => {
    writes.push(`${shown}|${hidden}`);
    parts.push([shown, hidden]);
  });
  return {
    subtitles,
    writes,
    /** 已显示的前缀。 */
    get text() {
      return parts.at(-1)?.[0] ?? '';
    },
    /** 不可见的占位部分。 */
    get hidden() {
      return parts.at(-1)?.[1] ?? '';
    },
  };
}

test('没有映射：一开始播放就整句显示，播完清除', () => {
  const s = screen();
  s.subtitles.begin('a', '你好世界');
  s.subtitles.report({ kind: 'progress', sentenceId: 'a', played: 100 });
  assert.deepEqual(s.writes, [], '开始播放之前不显示');
  s.subtitles.report({ kind: 'started', sentenceId: 'a' });
  assert.equal(s.text, '你好世界');
  s.subtitles.report({ kind: 'ended', sentenceId: 'a', played: 400 });
  assert.deepEqual(s.writes, ['你好世界|', '|']);
});

test('有映射：开始时刻不晚于已播采样数的字才显示，其余放在占位里；只在两段变化时写出', () => {
  const s = screen();
  s.subtitles.begin('a', '你好世界');
  s.subtitles.timing('a', [0, 100, 200, 300]);
  s.subtitles.report({ kind: 'started', sentenceId: 'a' });
  assert.equal(s.text, '你');
  s.subtitles.report({ kind: 'progress', sentenceId: 'a', played: 99 });
  s.subtitles.report({ kind: 'progress', sentenceId: 'a', played: 100 });
  s.subtitles.report({ kind: 'cursor', sentenceId: 'a', played: 250 });
  // 欠载：游标停住，字幕也停住。
  s.subtitles.report({ kind: 'underrun', sentenceId: 'a', played: 250 });
  s.subtitles.report({ kind: 'progress', sentenceId: 'a', played: 250 });
  assert.equal(s.text, '你好世');
  assert.equal(s.hidden, '界');
  s.subtitles.report({ kind: 'progress', sentenceId: 'a', played: 300 });
  s.subtitles.report({ kind: 'ended', sentenceId: 'a', played: 400 });
  assert.deepEqual(s.writes, ['你|好世界', '你好|世界', '你好世|界', '你好世界|', '|']);
});

test('版面固定：一开始播放整句就排在占位里，第一个字开始得晚时先只有占位', () => {
  const s = screen();
  s.subtitles.begin('a', '你好');
  s.subtitles.timing('a', [50, 100]);
  s.subtitles.report({ kind: 'started', sentenceId: 'a' });
  assert.deepEqual(s.writes, ['|你好']);
  s.subtitles.report({ kind: 'progress', sentenceId: 'a', played: 60 });
  s.subtitles.report({ kind: 'progress', sentenceId: 'a', played: 100 });
  assert.deepEqual(s.writes, ['|你好', '你|好', '你好|']);
  // 下一句开始：上一句先整体清除，再排好下一句。
  s.subtitles.begin('b', '再见');
  s.subtitles.timing('b', [0, 100]);
  s.subtitles.forget('a');
  s.subtitles.report({ kind: 'started', sentenceId: 'b' });
  assert.deepEqual(s.writes.slice(-2), ['|', '再|见']);
  assert.equal(visibleCount([0, 100, 100, 300], 100), 3);
  assert.equal(visibleCount([50], 0), 0);
});

test('映射整份更新：细化后变晚的字不收回；映射只覆盖一部分时其余暂不显示', () => {
  const s = screen();
  s.subtitles.begin('a', '你好世界');
  s.subtitles.timing('a', [0, 100]);
  s.subtitles.report({ kind: 'started', sentenceId: 'a' });
  s.subtitles.report({ kind: 'progress', sentenceId: 'a', played: 1000 });
  assert.equal(s.text, '你好', '映射还没覆盖到的字不显示');
  assert.equal(s.hidden, '世界', '但照样占位');
  // 细化：“好”其实从 300 开始，但已经显示了，不收回；新的映射覆盖了后面的字。
  s.subtitles.timing('a', [0, 300, 1100, 1200]);
  assert.equal(s.text, '你好');
  s.subtitles.report({ kind: 'progress', sentenceId: 'a', played: 1100 });
  assert.equal(s.text, '你好世');
  // 较早的游标回报不让进度倒退：按已回报的最大进度（1100）换算。
  s.subtitles.report({ kind: 'cursor', sentenceId: 'a', played: 900 });
  s.subtitles.timing('a', [0, 300, 1000, 1050]);
  assert.equal(s.text, '你好世界');
});

test('截断、令牌变化即清除；之后这一句的回报与映射都忽略', () => {
  const s = screen();
  s.subtitles.begin('a', '你好');
  s.subtitles.timing('a', [0, 100]);
  s.subtitles.report({ kind: 'started', sentenceId: 'a' });
  s.subtitles.forget('a');
  assert.equal(s.text, '');
  s.subtitles.report({ kind: 'progress', sentenceId: 'a', played: 200 });
  s.subtitles.timing('a', [0, 0]);
  s.subtitles.report({ kind: 'started', sentenceId: 'a' });
  assert.deepEqual(s.writes, ['你|好', '|']);

  s.subtitles.begin('b', '再见');
  s.subtitles.begin('c', '下一句');
  s.subtitles.report({ kind: 'started', sentenceId: 'b' });
  assert.equal(s.text, '再见');
  s.subtitles.clear();
  assert.deepEqual([s.text, s.hidden], ['', '']);
  s.subtitles.report({ kind: 'started', sentenceId: 'c' });
  assert.equal(s.text, '', '令牌变化前排队的句子也作废');
  // 回报截断同样清除。
  s.subtitles.begin('d', '好');
  s.subtitles.report({ kind: 'started', sentenceId: 'd' });
  s.subtitles.report({ kind: 'truncated', sentenceId: 'd', played: 0 });
  assert.deepEqual(s.writes.slice(-2), ['好|', '|']);
});

test('不可用的映射与不认识的句子都忽略', () => {
  assert.ok(validStarts([]));
  assert.ok(validStarts([0, 0, 5]));
  for (const bad of [null, '0,1', [0, -1], [5, 4], [0, 1.5], [0, Number.NaN], [0, '1']]) {
    assert.equal(validStarts(bad), false, JSON.stringify(bad));
  }
  const s = screen();
  s.subtitles.begin('a', '你好');
  s.subtitles.timing('a', [0, 100, 200]);
  s.subtitles.timing('a', [5, 4]);
  s.subtitles.timing('x', [0, 0]);
  s.subtitles.report({ kind: 'started', sentenceId: 'x' });
  s.subtitles.report({ kind: 'progress', sentenceId: 'x', played: 1 });
  assert.deepEqual(s.writes, []);
  s.subtitles.report({ kind: 'started', sentenceId: 'a' });
  assert.equal(s.text, '你好', '映射都不可用：整句显示');
});

/**
 * 页面把 AudioWorklet 的回报交给字幕（与 page.js 的做法相同），逐个渲染块核对显示的字：
 * 不早于 AudioWorklet 真实的游标，落后不超过 10ms 加一个渲染块（换算成原始采样）。
 */
function drive(w: Worklet, s: ReturnType<typeof screen>, starts: readonly number[]) {
  let delivered = 0;
  const lag = (480 + 128) / 2;
  const visible = (played: number) => starts.filter((start) => start <= played).length;
  return (quanta: number) => {
    for (let q = 0; q < quanta; q++) {
      if (q % 93 === 0) w.send({ type: 'hb' });
      w.render(1);
      for (; delivered < w.posted.length; delivered++)
        s.subtitles.report(w.posted[delivered] as { kind: string });
      const shown = [...s.text].length;
      const cursor = w.cursor();
      assert.ok(shown <= visible(cursor), `游标 ${cursor} 时显示了“${s.text}”`);
      if (w.processor.queue[0]?.started)
        assert.ok(shown >= visible(cursor - lag), `游标 ${cursor} 时只显示了“${s.text}”`);
    }
  };
}

for (const [name, fill] of [
  ['有声', 0.2],
  ['只出字幕的静音帧', 0],
] as const) {
  test(`AudioWorklet 驱动（${name}）：唤醒信号期间不显示，随后按渲染帧逐字推进，播完清除`, async () => {
    const w = await worklet();
    const s = screen();
    // 原始 24kHz：各字从 0、71、163、271ms 开始，不与 100ms 的游标回报对齐。
    const starts = [0, 1700, 3900, 6500];
    w.send({ type: 'hb' });
    w.send({ type: 'lease', ttlMs: 60_000 });
    s.subtitles.begin('a', '你好世界');
    s.subtitles.timing('a', starts);
    w.send({ type: 'begin', id: 'a' });
    w.send({ type: 'pcm', id: 'a', data: new Float32Array(16_800).fill(fill), src: 8400 });
    w.send({ type: 'end', id: 'a', src: 8400 });
    const step = drive(w, s, starts);
    step(Math.floor(WAKE_FRAMES / 128));
    assert.deepEqual(s.writes, [], '唤醒信号期间不显示');
    step(2);
    assert.equal(s.text, '你');
    step(Math.ceil(16_800 / 128));
    assert.deepEqual(s.writes, ['你|好世界', '你好|世界', '你好世|界', '你好世界|', '|']);
  });
}

test('AudioWorklet 驱动：欠载时字幕停住；欠载超过 1.5 秒恢复时先放唤醒信号，期间字幕不动', async () => {
  const w = await worklet();
  const s = screen();
  const starts = [0, 1000, 3000, 3600];
  w.send({ type: 'hb' });
  w.send({ type: 'lease', ttlMs: 60_000 });
  s.subtitles.begin('a', '你好世界');
  s.subtitles.timing('a', starts);
  w.send({ type: 'begin', id: 'a' });
  w.send({ type: 'pcm', id: 'a', data: new Float32Array(4800).fill(0.2), src: 2400 });
  const step = drive(w, s, starts);
  // 唤醒 150ms + 正文 100ms，之后欠载约 1.65 秒。
  step(Math.ceil((0.25 * 48_000) / 128));
  assert.equal(s.text, '你好');
  const writes = s.writes.length;
  step(Math.ceil((1.65 * 48_000) / 128));
  assert.equal(s.writes.length, writes, '欠载期间不再写出');
  w.send({ type: 'pcm', id: 'a', data: new Float32Array(4800).fill(0.2), src: 2400 });
  w.send({ type: 'end', id: 'a', src: 4800 });
  step(Math.floor(WAKE_FRAMES / 128));
  assert.equal(s.text, '你好', '唤醒信号期间字幕不动');
  step(Math.ceil(4800 / 128) + 8);
  assert.deepEqual(s.writes, ['你|好世界', '你好|世界', '你好世|界', '你好世界|', '|']);
});

test('AudioWorklet 驱动：截断与自静音时字幕立即清除', async () => {
  const w = await worklet();
  const s = screen();
  w.send({ type: 'hb' });
  w.send({ type: 'lease', ttlMs: 60_000 });
  s.subtitles.begin('a', '你好');
  w.send({ type: 'begin', id: 'a' });
  w.send({ type: 'pcm', id: 'a', data: new Float32Array(48_000).fill(0.2), src: 24_000 });
  const step = drive(w, s, [0, 0]);
  step(80);
  assert.equal(s.text, '你好');
  // 页面收到宿主的截断就清除，不等 AudioWorklet 回报（page.js 的做法）。
  s.subtitles.forget('a');
  w.send({ type: 'truncate', id: 'a' });
  assert.deepEqual([s.text, s.hidden], ['', '']);
  step(2);
  assert.equal(s.text, '');

  // 收不到心跳：AudioWorklet 自静音并回报截断，字幕随之清除。
  s.subtitles.begin('b', '再见');
  w.send({ type: 'begin', id: 'b' });
  w.send({ type: 'pcm', id: 'b', data: new Float32Array(96_000).fill(0.2), src: 48_000 });
  let delivered = w.posted.length;
  for (let q = 0; q < 400; q++) {
    w.render(1);
    for (; delivered < w.posted.length; delivered++)
      s.subtitles.report(w.posted[delivered] as { kind: string });
  }
  assert.ok(w.kinds().includes('muted'));
  assert.deepEqual(s.writes.slice(-2), ['再见|', '|']);
});

/** 手动推进的时钟与定时器（代替页面的 performance.now() 与 setTimeout）。 */
function manualTimers() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    timers: {
      now: () => now,
      set: (callback: () => void, ms: number) => {
        const id = next++;
        timers.set(id, { at: now + Math.max(0, ms), callback });
        return id;
      },
      clear: (handle: unknown) => {
        timers.delete(handle as number);
      },
    },
    /** 排着的定时器个数。 */
    get pending() {
      return timers.size;
    },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at);
        const first = due[0];
        if (!first) break;
        timers.delete(first[0]);
        now = first[1].at;
        first[1].callback();
      }
      now = target;
    },
  };
}

/** 带呈现延迟的字幕：每次写出记为 [时刻, “已显示|未显示”]。 */
function delayedScreen(delayMs: number) {
  const clock = manualTimers();
  const writes: Array<[at: number, text: string]> = [];
  const subtitles = new Subtitles((shown, hidden) => {
    writes.push([clock.timers.now(), `${shown}|${hidden}`]);
  }, clock.timers);
  subtitles.setDelay(delayMs);
  return { clock, subtitles, writes };
}

test('呈现延迟：开始、进度与播完都推迟 D 生效，期间没有新回报也按定时器显示', () => {
  const { clock, subtitles, writes } = delayedScreen(100);
  subtitles.begin('a', '你好世界');
  subtitles.timing('a', [0, 100, 200, 300]);
  subtitles.report({ kind: 'started', sentenceId: 'a' });
  assert.deepEqual(writes, [], '还没到 D');
  clock.advance(10);
  subtitles.report({ kind: 'progress', sentenceId: 'a', played: 150 });
  clock.advance(30);
  subtitles.report({ kind: 'progress', sentenceId: 'a', played: 300 });
  clock.advance(10);
  subtitles.report({ kind: 'ended', sentenceId: 'a', played: 400 });
  // 之后不再有任何回报：显示与清除都靠定时器。
  clock.advance(1000);
  assert.deepEqual(writes, [
    [100, '你|好世界'],
    [110, '你好|世界'],
    [140, '你好世界|'],
    [150, '|'],
  ]);
  assert.equal(clock.pending, 0, '队列空了不留定时器');
});

test('呈现延迟：上一句的清除与下一句的开始按原来的先后推迟', () => {
  const { clock, subtitles, writes } = delayedScreen(80);
  subtitles.begin('a', '甲');
  subtitles.begin('b', '乙');
  subtitles.report({ kind: 'started', sentenceId: 'a' });
  clock.advance(500);
  subtitles.report({ kind: 'ended', sentenceId: 'a', played: 100 });
  subtitles.report({ kind: 'started', sentenceId: 'b' });
  clock.advance(500);
  assert.deepEqual(writes, [
    [80, '甲|'],
    [580, '|'],
    [580, '乙|'],
  ]);
});

test('呈现延迟：截断、令牌变化与页面静音立即清除，丢掉推迟中的回报', () => {
  const { clock, subtitles, writes } = delayedScreen(100);
  subtitles.begin('a', '你好');
  subtitles.timing('a', [0, 50]);
  subtitles.report({ kind: 'started', sentenceId: 'a' });
  clock.advance(120);
  subtitles.report({ kind: 'progress', sentenceId: 'a', played: 60 });
  assert.deepEqual(writes, [[100, '你|好']]);
  // AudioWorklet 回报截断：不等 D。
  clock.advance(5);
  subtitles.report({ kind: 'truncated', sentenceId: 'a', played: 60 });
  assert.deepEqual(writes.at(-1), [125, '|']);
  clock.advance(1000);
  assert.equal(writes.length, 2, '推迟中的进度不再生效');

  // 令牌变化（page.js 收到新令牌）与页面静音都走 clear()。
  subtitles.begin('b', '再见');
  subtitles.report({ kind: 'started', sentenceId: 'b' });
  clock.advance(150);
  subtitles.report({ kind: 'ended', sentenceId: 'b', played: 100 });
  assert.deepEqual(writes.at(-1), [1225, '再见|']);
  subtitles.clear();
  assert.deepEqual(writes.at(-1), [1275, '|']);
  assert.equal(clock.pending, 0);
});

test('呈现延迟：改小时到期的回报立即生效；不合格的值忽略；为 0 时与不推迟相同', () => {
  const { clock, subtitles, writes } = delayedScreen(200);
  subtitles.begin('a', '你好');
  subtitles.report({ kind: 'started', sentenceId: 'a' });
  clock.advance(50);
  subtitles.setDelay(40);
  assert.deepEqual(writes, [[50, '你好|']]);
  for (const bad of [-1, 301, 1.5, Number.NaN, '20', null]) subtitles.setDelay(bad);
  assert.equal(subtitles.delayMs, 40);
  subtitles.setDelay(0);
  subtitles.report({ kind: 'ended', sentenceId: 'a', played: 10 });
  assert.deepEqual(writes.at(-1), [50, '|']);
  assert.equal(clock.pending, 0);
});
