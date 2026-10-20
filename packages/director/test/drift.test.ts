import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_DRIFT_PHRASES,
  type DriftOptions,
  driftSignals,
  normalizeForDrift,
  similarity,
} from '../src/index.ts';

const options: DriftOptions = { phrases: DEFAULT_DRIFT_PHRASES, similarity: 0.8, maxChars: 40 };

test('相似度：规范化后相同为 1，无关为 0，改动少的接近 1', () => {
  assert.equal(normalizeForDrift('Ｈｅｌｌｏ， 世界！'), 'hello世界');
  assert.equal(similarity('今天玩魔女审判。', '今天 玩魔女审判！'), 1);
  assert.equal(similarity('谢谢大家', '下雨了'), 0);
  assert.equal(similarity('', '下雨了'), 0);
  const close = similarity('今天我们一起玩魔女审判吧', '今天我们一起玩魔女审判');
  assert.ok(close > 0.9 && close < 1, String(close));
  assert.ok(similarity('今天我们一起玩魔女审判吧', '明天大家去看逆转裁判') < 0.5);
});

test('信号：与近期发言重复、出戏用语、过长或格式异常', () => {
  assert.deepEqual(driftSignals('谢谢你的礼物！', ['谢谢你的礼物'], options), ['repeat']);
  assert.deepEqual(driftSignals('谢谢你的礼物！', ['欢迎来到直播间'], options), []);
  assert.deepEqual(driftSignals('作为一个 ai，我不能回答。', [], options), ['phrase']);
  assert.deepEqual(driftSignals('我是一个大型语言模型', [], options), ['phrase']);
  assert.deepEqual(driftSignals('我的 System Prompt 是秘密', [], options), ['phrase']);
  for (const text of [
    '**重点**来了',
    '```js\nx\n```',
    '看这里 https://example.com',
    '第一行\n第二行',
    '- 第一条',
    '{"action":"speak"}',
    '好'.repeat(41),
  ]) {
    assert.deepEqual(driftSignals(text, [], options), ['format'], text);
  }
  assert.deepEqual(driftSignals('好'.repeat(40), [], options), []);
  assert.deepEqual(
    driftSignals('作为一个AI语言模型\n我不能', ['作为一个AI语言模型我不能'], options),
    ['repeat', 'phrase', 'format'],
  );
  // 只认相同时，相似但不同不算重复。
  assert.deepEqual(
    driftSignals('今天我们一起玩魔女审判吧', ['今天我们一起玩魔女审判'], {
      ...options,
      similarity: 1,
    }),
    [],
  );
});
