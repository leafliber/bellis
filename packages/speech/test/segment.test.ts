import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { heardPrefix, Segmenter, speakable } from '../src/index.ts';

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
