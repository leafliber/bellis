import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { Alignment, heardPrefix, Segmenter, speakable, subtitleStarts } from '../src/index.ts';

test('在句末标点处切句，首句在第一个分句处提前切开', () => {
  const s = new Segmenter();
  const out = [...s.push('欢迎大家，我们今天先玩魔女审判。然后聊聊天！'), ...s.flush()];
  assert.deepEqual(
    out.map((x) => x.subtitle),
    ['欢迎大家，', '我们今天先玩魔女审判。', '然后聊聊天！'],
  );
});

test('流式输入：句子未结束前不切，结束时冲出剩余部分', () => {
  const s = new Segmenter();
  assert.deepEqual(s.push('今天天气'), []);
  assert.deepEqual(s.push('不错'), []);
  assert.deepEqual(
    s.flush().map((x) => x.subtitle),
    ['今天天气不错'],
  );
});

test('连续的句末标点并入同一句；过长的句子在分句处切开', () => {
  const s = new Segmenter({ maxLength: 10 });
  const out = [
    ...s.push('真的吗？！'),
    ...s.push('这是一个非常非常长，长到需要切开的句子。'),
    ...s.flush(),
  ];
  assert.equal(out[0]?.subtitle, '真的吗？！');
  assert.ok(out.slice(1).every((x) => [...x.subtitle].length <= 10));
});

test('朗读文本：数字逐字读，不读的符号去掉，对齐表指回字幕位置', () => {
  const { spoken, align } = speakable('第3关（难）');
  assert.equal(spoken, '第三关难');
  assert.deepEqual(align, [0, 1, 2, 4]);
});

test('任意文本切句后拼回原文（去掉首尾空白）', () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom('好', '的', '，', '。', '！', '？', '我', '们', '\n', 'a', '1'), {
        maxLength: 80,
      }),
      (chars) => {
        const text = chars.join('');
        const s = new Segmenter();
        const out = [...s.push(text), ...s.flush()];
        assert.equal(
          out
            .map((x) => x.subtitle)
            .join('')
            .replace(/\s/gu, ''),
          text.replace(/\s/gu, ''),
        );
        for (const [i, x] of out.entries()) assert.equal(x.index, i);
      },
    ),
  );
});

test('按播放游标算已听到的前缀：只计入完整播出的码点；没有映射时返回 undefined', () => {
  const sentence = { index: 0, subtitle: '第3关！', ...speakable('第3关！') };
  const timing = [...sentence.spoken].map((_, i) => ({ sample: i * 100, char: i }));
  assert.equal(heardPrefix(sentence, 0, timing, 400), '');
  assert.equal(heardPrefix(sentence, 199, timing, 400), '第');
  assert.equal(heardPrefix(sentence, 200, timing, 400), '第3');
  assert.equal(heardPrefix(sentence, 400, timing, 400), '第3关！');
  assert.equal(heardPrefix(sentence, 200, undefined, 400), undefined);
});

test('合成总长未知时，最后一个码点不计入已听到的部分', () => {
  const sentence = { index: 0, subtitle: '你好', ...speakable('你好') };
  const timing = [...sentence.spoken].map((_, i) => ({ sample: i * 100, char: i }));
  assert.equal(heardPrefix(sentence, 200, timing, undefined), '你');
  assert.equal(heardPrefix(sentence, 200, timing, 200), '你好');
});

const sentenceOf = (subtitle: string) => ({ index: 0, subtitle, ...speakable(subtitle) });
const evenly = (spoken: string, step: number) =>
  [...spoken].map((_, i) => ({ sample: i * step, char: i }));

test('字幕映射：数字按朗读码点计，不朗读的符号随后面第一个朗读的字显示，句末的随最后一个字', () => {
  // 朗读文本：他说第三关，align = [0, 1, 3, 4, 5, 7]。
  const sentence = sentenceOf('他说“第3关”，');
  assert.equal(sentence.spoken, '他说第三关，');
  assert.deepEqual(
    subtitleStarts(sentence, evenly(sentence.spoken, 100)),
    [0, 100, 200, 200, 300, 400, 500, 500],
  );
  const quoted = sentenceOf('好（真的）');
  assert.deepEqual(subtitleStarts(quoted, evenly(quoted.spoken, 100)), [0, 100, 100, 200, 200]);
  assert.equal(subtitleStarts(sentence, undefined), undefined);
});

test('字幕映射：没有时间点的字取后面最近的开始，之后都没有的暂不给出；结果不减', () => {
  const sentence = sentenceOf('你好世界');
  assert.deepEqual(
    subtitleStarts(sentence, [
      { sample: 0, char: 0 },
      { sample: 300, char: 2 },
    ]),
    [0, 300, 300],
  );
  // 违反“按采样偏移不减”的映射也给出不减的结果：一个字最晚在它后面的字开始时显示。
  assert.deepEqual(
    subtitleStarts(sentence, [
      { sample: 0, char: 0 },
      { sample: 500, char: 1 },
      { sample: 200, char: 2 },
      { sample: 600.4, char: 3 },
    ]),
    [0, 200, 200, 600],
  );
});

test('属性：页面显示的字幕（开始不晚于游标）总包含写回的部分（结束不晚于游标），最多多出正在播的一个字', () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom('好', '的', '，', '。', '“', '”', '（', '）', '3', 'a', ' '), {
        minLength: 1,
        maxLength: 24,
      }),
      fc.array(
        fc.record({
          text: fc.constantFrom('好', '的', '好的', '，', '三', 'a'),
          startMs: fc.integer({ min: 0, max: 4000 }),
          length: fc.integer({ min: 0, max: 600 }),
        }),
        { maxLength: 8 },
      ),
      fc.option(fc.integer({ min: 0, max: 6000 })),
      fc.integer({ min: 0, max: 7000 }),
      (chars, words, total, played) => {
        const subtitle = chars.join('').trim();
        const { spoken, align } = speakable(subtitle);
        if (!spoken) return;
        const line = { index: 0, subtitle, spoken, align };
        const alignment = new Alignment(spoken, 1000, { msPerChar: 200 });
        alignment.refine(words.map((w) => ({ ...w, endMs: w.startMs + w.length })));
        if (total !== null) alignment.complete(total);
        const starts = subtitleStarts(line, alignment.timing) ?? [];
        const shown = [...subtitle].slice(0, starts.filter((s) => s <= played).length).join('');
        const heard = heardPrefix(line, played, alignment.timing, alignment.totalSamples) ?? '';
        assert.ok(shown.startsWith(heard), `显示“${shown}”，写回“${heard}”`);
        const extra = [...shown].slice([...heard].length);
        const voicedExtra = extra.filter((_, k) => align.includes([...heard].length + k));
        assert.ok(voicedExtra.length <= 1, `显示“${shown}”比写回“${heard}”多出不止一个字`);
      },
    ),
  );
});
