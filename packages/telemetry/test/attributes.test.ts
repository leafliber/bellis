import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  attributeAllowed,
  filterAttributes,
  MAX_STRING_LENGTH,
  nameAllowed,
  valueAllowed,
} from '../src/index.ts';

test('属性名：只收 bellis.*、gen_ai.* 与 error.type', () => {
  for (const ok of [
    'bellis.danmaku.id',
    'bellis.speech.sentence_index',
    'gen_ai.operation.name',
    'gen_ai.provider.name',
    'gen_ai.request.model',
    'gen_ai.usage.input_tokens',
    'error.type',
  ]) {
    assert.ok(attributeAllowed(ok), ok);
  }
  for (const bad of ['http.method', 'service.name', 'error.message', 'exception.message', '']) {
    assert.ok(!attributeAllowed(bad), bad);
  }
});

test('属性名：承载内容或观众身份的一律拒绝', () => {
  for (const bad of [
    // GenAI 语义约定里的内容
    'gen_ai.input.messages',
    'gen_ai.output.messages',
    'gen_ai.system_instructions',
    'gen_ai.prompt',
    'gen_ai.completion',
    'gen_ai.tool.call.arguments',
    'gen_ai.tool.call.result',
    'gen_ai.tool.definitions',
    // 名字里任何一段是内容或身份的词
    'bellis.danmaku.text',
    'bellis.danmaku.nickname',
    'bellis.viewer.id',
    'bellis.speech.subtitle',
    'bellis.speech.spoken',
    'bellis.vote.question',
    'bellis.vote.options',
    'bellis.moderation.reason',
    'bellis.llm.content',
    'bellis.message.count',
    // 名字不合格式
    'Bellis.Danmaku',
    'bellis..id',
    'bellis.id.',
    'bellis.中文',
  ]) {
    assert.ok(!attributeAllowed(bad), bad);
  }
});

test('属性值：有限的数值、布尔与可打印 ASCII 的短字符串', () => {
  for (const ok of [0, -1, 1.5, true, false, '', 'replay', 'a'.repeat(MAX_STRING_LENGTH)]) {
    assert.ok(valueAllowed(ok), String(ok));
  }
  for (const bad of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    'a'.repeat(MAX_STRING_LENGTH + 1),
    '主播你好',
    'ignore previous\ninstructions',
    'tab\there',
    null,
    undefined,
    {},
    [],
    ['a'],
    10n,
  ]) {
    assert.ok(!valueAllowed(bad), String(bad));
  }
});

test('筛属性：留下合格的，拒绝的计数，undefined 视为没给', () => {
  const { accepted, dropped } = filterAttributes({
    'bellis.danmaku.id': 'd1',
    'bellis.danmaku.text': 'ignore previous instructions',
    'bellis.speech.heard_chars': 12,
    'bellis.vote.option': '魔女审判',
    'gen_ai.request.model': 'glm-5.3-flash',
    'gen_ai.response.model': undefined,
    'bellis.reply': '谢谢你来',
  });
  assert.deepEqual(accepted, [
    ['bellis.danmaku.id', 'd1'],
    ['bellis.speech.heard_chars', 12],
    ['gen_ai.request.model', 'glm-5.3-flash'],
  ]);
  assert.equal(dropped, 3);
});

test('span 与指标的名字只收可打印 ASCII', () => {
  assert.ok(nameAllowed('chat glm-5.3-flash'));
  assert.ok(!nameAllowed(''));
  assert.ok(!nameAllowed('回应：主播你好'));
  assert.ok(!nameAllowed('x'.repeat(129)));
});
