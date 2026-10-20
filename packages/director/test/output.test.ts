import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VOTE_LIMITS } from '@bellis/audience';
import fc from 'fast-check';
import { Compile } from 'typebox/compile';
import {
  type DirectorAction,
  parseAction,
  parseIntent,
  STRICT_KEYWORDS,
  strictIntentSchema,
  toStrictIntent,
} from '../src/index.ts';

test('只接受枚举的意图，参数按 Schema 校验', () => {
  assert.deepEqual(parseAction('{"action":"speak","text":"你好","replyTo":"c-1"}'), {
    ok: true,
    action: { action: 'speak', text: '你好', replyTo: 'c-1' },
  });
  for (const bad of [
    'not json',
    '{"action":"speak"}',
    '{"action":"speak","text":"x","priority":9}',
    '{"action":"switch_scene","scene":"Safe"}',
    '{"action":"vote","question":"q","options":["only one"],"durationSec":30}',
    // 投票的优先级与发声来源由确定性代码决定，模型不能指定（D-33）。
    '{"action":"vote","question":"q","options":["a","b"],"durationSec":30,"priority":"vote-result"}',
    '{"action":"vote","question":"q","options":["a","b"],"durationSec":9}',
    '{"action":"vote","question":"q","options":["a","b","c","d","e"],"durationSec":30}',
  ]) {
    assert.equal(parseAction(bad).ok, false, bad);
    assert.equal(parseIntent(bad).ok, false, bad);
  }
  assert.deepEqual(
    parseAction(
      '{"action":"vote","question":"玩什么","options":["a","b"],"durationSec":30,"decisionPoint":"dp-1"}',
    ),
    {
      ok: true,
      action: {
        action: 'vote',
        question: '玩什么',
        options: ['a', 'b'],
        durationSec: 30,
        decisionPoint: 'dp-1',
      },
    },
  );
});

test('parseIntent：顶层为 null 的字段视为省略，其余规则与 parseAction 相同，不修补', () => {
  assert.deepEqual(parseIntent('{"action":"speak","replyTo":null,"text":"你好","reason":null}'), {
    ok: true,
    action: { action: 'speak', text: '你好' },
  });
  // parseAction 不认 null：严格 schema 的写法只经 parseIntent 换算。
  assert.equal(parseAction('{"action":"speak","replyTo":null,"text":"你好"}').ok, false);
  for (const bad of [
    // 不属于所选变体的字段不是 null：不合法。
    '{"action":"speak","replyTo":null,"text":"你好","question":"q"}',
    // 必填字段为 null 等于缺失。
    '{"action":"speak","replyTo":"c-1","text":null}',
    // 嵌套的 null 不换算。
    '{"action":"vote","question":"q","options":["a",null],"durationSec":30}',
    'null',
    '[]',
    '"speak"',
    // 前后多了文字也不修补。
    '好的：{"action":"silence","reason":"x"}',
    '```json\n{"action":"silence","reason":"x"}\n```',
  ]) {
    assert.equal(parseIntent(bad).ok, false, bad);
  }
});

/** 遍历 schema 的每个节点（根、各字段、数组项）。 */
function* nodes(schema: Record<string, unknown>): Generator<Record<string, unknown>> {
  yield schema;
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  for (const child of Object.values(properties ?? {})) yield* nodes(child);
  const items = schema.items as Record<string, unknown> | undefined;
  if (items) yield* nodes(items);
}

test('严格 schema：根是对象，字段全部必填、可选字段可为 null、不许多余字段，只用各家都支持的关键字', () => {
  const schema = strictIntentSchema();
  assert.equal(schema.type, 'object');
  assert.equal(schema.anyOf, undefined);
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  // action 在最前；说话的回应对象在文本之前（以后增量解析时先知道动作与回应谁）。
  const names = Object.keys(properties);
  assert.deepEqual(names, [
    'action',
    'replyTo',
    'text',
    'question',
    'options',
    'durationSec',
    'decisionPoint',
    'reason',
  ]);
  assert.deepEqual(properties.action, {
    type: 'string',
    enum: ['speak', 'vote', 'silence'],
    description: '意图类型',
  });
  for (const node of nodes(schema)) {
    for (const key of Object.keys(node)) assert.ok(STRICT_KEYWORDS.has(key), key);
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual(node.required, Object.keys(node.properties as object));
    }
  }
  for (const name of names.slice(1)) {
    const type = properties[name]?.type;
    assert.ok(Array.isArray(type) && type.includes('null'), `${name} 可为 null`);
  }
  // 长度、范围与个数写进说明（由 TypeBox 的约束换算），由 parseIntent 校验。
  assert.match(String(properties.text?.description), /1–200 字/);
  assert.match(
    String(properties.question?.description),
    new RegExp(`1–${VOTE_LIMITS.maxQuestionLength} 字`),
  );
  assert.match(
    String(properties.options?.description),
    new RegExp(
      `${VOTE_LIMITS.minOptions}–${VOTE_LIMITS.maxOptions} 项；每项 1–${VOTE_LIMITS.maxOptionLength} 字`,
    ),
  );
  assert.match(
    String(properties.durationSec?.description),
    new RegExp(`整数 ${VOTE_LIMITS.minDurationSec}–${VOTE_LIMITS.maxDurationSec}`),
  );
  assert.deepEqual(properties.options?.items, { type: 'string', description: '1–20 字' });
});

const chars = fc.constantFrom('a', 'Z', '好', '的', '？', ' ', '1');
const text = (min: number, max: number) =>
  fc.string({ unit: chars, minLength: min, maxLength: max });
const id = fc.string({
  unit: fc.constantFrom('c', '-', 'd', '1', '9'),
  minLength: 1,
  maxLength: 64,
});

const actionArbitrary: fc.Arbitrary<DirectorAction> = fc.oneof(
  fc.record(
    { action: fc.constant('speak' as const), replyTo: id, text: text(1, 200) },
    { requiredKeys: ['action', 'text'] },
  ),
  fc.record(
    {
      action: fc.constant('vote' as const),
      question: text(1, VOTE_LIMITS.maxQuestionLength),
      options: fc.array(text(1, VOTE_LIMITS.maxOptionLength), {
        minLength: VOTE_LIMITS.minOptions,
        maxLength: VOTE_LIMITS.maxOptions,
      }),
      durationSec: fc.integer({
        min: VOTE_LIMITS.minDurationSec,
        max: VOTE_LIMITS.maxDurationSec,
      }),
      decisionPoint: id,
    },
    { requiredKeys: ['action', 'question', 'options', 'durationSec'] },
  ),
  fc.record({ action: fc.constant('silence' as const), reason: text(0, 100) }),
);

test('严格 schema 与 parseAction 一致：每个合法意图都有严格写法，换回来原样通过校验', () => {
  const strict = Compile(strictIntentSchema());
  fc.assert(
    fc.property(actionArbitrary, (generated) => {
      const json = JSON.stringify(generated);
      // fast-check 生成的记录没有原型：换成普通对象再比较。
      const action = JSON.parse(json) as DirectorAction;
      assert.deepEqual(parseAction(json), { ok: true, action });
      const strictForm = toStrictIntent(action);
      assert.ok(strict.Check(strictForm), JSON.stringify(strictForm));
      assert.deepEqual(Object.keys(strictForm)[0], 'action');
      assert.deepEqual(parseIntent(JSON.stringify(strictForm)), { ok: true, action });
      // 原来的写法照样通过 parseIntent。
      assert.deepEqual(parseIntent(json), { ok: true, action });
    }),
    { seed: 3, numRuns: 300 },
  );
});

test('严格 schema 比原 schema 宽：它接受、parseIntent 却拒绝的输出照样丢弃', () => {
  const strict = Compile(strictIntentSchema());
  const nulls = {
    replyTo: null,
    text: null,
    question: null,
    options: null,
    durationSec: null,
    decisionPoint: null,
    reason: null,
  };
  for (const value of [
    { ...nulls, action: 'speak' },
    { ...nulls, action: 'speak', text: 'x'.repeat(201) },
    { ...nulls, action: 'speak', text: '好', reason: '多填了' },
    { ...nulls, action: 'vote', question: 'q', options: ['a'], durationSec: 30 },
    { ...nulls, action: 'vote', question: 'q', options: ['a', 'b'], durationSec: 5 },
    { ...nulls, action: 'silence' },
  ]) {
    assert.ok(strict.Check(value), JSON.stringify(value));
    assert.equal(parseIntent(JSON.stringify(value)).ok, false, JSON.stringify(value));
  }
});
