import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { Alignment, heardPrefix, Segmenter, speakable } from '../src/index.ts';

const RATE = 1000;
const starts = (alignment: Alignment) => alignment.timing.map((t) => t.sample);

test('插值：句段一到按字数铺开，标点处加权停顿，总数未知时按语速估计', () => {
  const alignment = new Alignment('你好，世界。', RATE, { msPerChar: 100 });
  // 权重：你 1、好 1、，1、世 1、界 1、。1.5
  assert.deepEqual(starts(alignment), [0, 100, 200, 300, 400, 500]);
  assert.equal(alignment.totalSamples, undefined);
  assert.equal(alignment.estimatedSamples, 650);
  assert.deepEqual(
    alignment.timing.map((t) => t.char),
    [0, 1, 2, 3, 4, 5],
  );
});

test('合成完成后按实际总采样数修正插值', () => {
  const alignment = new Alignment('你好，世界。', RATE, { msPerChar: 100 });
  alignment.complete(1300);
  assert.equal(alignment.totalSamples, 1300);
  assert.deepEqual(starts(alignment), [0, 200, 400, 600, 800, 1000]);
});

test('细化：时间戳替换能对上的码点，对不上的片段在相邻时间戳之间插值', () => {
  const alignment = new Alignment('二零一九年，好。', RATE, { msPerChar: 100 });
  alignment.refine([
    { text: '二', startMs: 150, endMs: 290 },
    { text: '零', startMs: 290, endMs: 420 },
    // “一九”没有时间戳。
    { text: '年,', startMs: 760, endMs: 1000 },
    { text: '好。', startMs: 1200, endMs: 1400 },
  ]);
  assert.equal(alignment.refinedChars, 6);
  // 二 150、零 290；一九在 420 与 760 之间插值；年 760，“，”在年的结尾 1000；好 1200，“。”在 1400。
  assert.deepEqual(starts(alignment), [150, 290, 420, 590, 760, 1000, 1200, 1400]);
  alignment.complete(1500);
  assert.deepEqual(starts(alignment), [150, 290, 420, 590, 760, 1000, 1200, 1400]);
});

test('细化后句尾没有时间戳的码点在最后一个时间戳与总采样数之间插值', () => {
  const alignment = new Alignment('你好呀', RATE, { msPerChar: 100 });
  alignment.refine([{ text: '你', startMs: 0, endMs: 300 }]);
  assert.deepEqual(starts(alignment), [0, 300, 400]);
  alignment.complete(900);
  assert.deepEqual(starts(alignment), [0, 300, 600]);
});

test('对不上的词不往远处乱对，也不打乱顺序', () => {
  const alignment = new Alignment('今天天气很好', RATE, { msPerChar: 100 });
  alignment.refine([
    { text: '2026', startMs: 0, endMs: 100 },
    { text: '今天', startMs: 100, endMs: 300 },
    { text: '天气', startMs: 300, endMs: 500 },
    { text: '今天', startMs: 900, endMs: 1000 },
  ]);
  assert.deepEqual(starts(alignment).slice(0, 4), [100, 200, 300, 400]);
  const samples = starts(alignment);
  assert.ok(samples.every((s, i) => i === 0 || s >= (samples[i - 1] as number)));
});

test('时间戳超出实际总采样数时截到总数，映射保持不减', () => {
  const alignment = new Alignment('你好', RATE, { msPerChar: 100 });
  alignment.refine([
    { text: '你', startMs: 0, endMs: 500 },
    { text: '好', startMs: 400, endMs: 900 },
  ]);
  alignment.complete(600);
  assert.deepEqual(starts(alignment), [0, 500]);
});

test('写回按细化后的映射计：结束时刻不晚于游标的码点才算听到', () => {
  const [sentence] = new Segmenter().push('第3关！');
  if (!sentence) throw new Error('没有句子');
  const alignment = new Alignment(sentence.spoken, RATE, { msPerChar: 100 });
  // 插值下“第三”已在 200 结束；细化后“第”就占到 300。
  assert.equal(heardPrefix(sentence, 250, alignment.timing, alignment.totalSamples), '第3');
  alignment.refine([
    { text: '第', startMs: 0, endMs: 300 },
    { text: '三', startMs: 300, endMs: 400 },
  ]);
  assert.equal(heardPrefix(sentence, 250, alignment.timing, alignment.totalSamples), '');
  assert.equal(heardPrefix(sentence, 300, alignment.timing, alignment.totalSamples), '第');
});

test('属性：任意时间戳下映射覆盖每个码点、不减，且不超过已知的总采样数', () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 20 }),
      fc.array(
        fc.record({
          text: fc.string({ maxLength: 4 }),
          startMs: fc.integer({ min: 0, max: 5000 }),
          length: fc.integer({ min: 0, max: 800 }),
        }),
        { maxLength: 10 },
      ),
      fc.option(fc.integer({ min: 0, max: 8000 })),
      (text, words, total) => {
        const { spoken } = speakable(text);
        if (!spoken) return;
        const alignment = new Alignment(spoken, RATE, { msPerChar: 200 });
        alignment.refine(words.map((w) => ({ ...w, endMs: w.startMs + w.length })));
        if (total !== null) alignment.complete(total);
        const timing = alignment.timing;
        assert.equal(timing.length, [...spoken].length);
        timing.forEach((point, i) => {
          assert.equal(point.char, i);
          if (i > 0) assert.ok(point.sample >= (timing[i - 1]?.sample as number));
          if (total !== null) assert.ok(point.sample <= total);
        });
      },
    ),
  );
});
