import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { IntentScanner, parseIntent, type ScannedField, TextQueue } from '../src/index.ts';

/** 一次扫描的结果：吐出的文本、开始与结束的次数、文本开始时与最后的顶层取值、是否停止。 */
interface Scan {
  deltas: string[];
  starts: number;
  ends: number;
  atStart: { action?: ScannedField; replyTo?: ScannedField } | undefined;
  action: ScannedField | undefined;
  replyTo: ScannedField | undefined;
  stopped: boolean;
  done: boolean;
}

function scan(chunks: readonly string[]): Scan {
  const scanner = new IntentScanner();
  const result: Scan = {
    deltas: [],
    starts: 0,
    ends: 0,
    atStart: undefined,
    action: undefined,
    replyTo: undefined,
    stopped: false,
    done: false,
  };
  for (const chunk of chunks) {
    for (const event of scanner.push(chunk)) {
      if (event.type === 'text-start') {
        result.starts += 1;
        const { action, replyTo } = event;
        result.atStart = { ...(action ? { action } : {}), ...(replyTo ? { replyTo } : {}) };
      } else if (event.type === 'text') {
        assert.ok(event.delta.length > 0, '不吐空的增量');
        result.deltas.push(event.delta);
      } else {
        result.ends += 1;
      }
    }
  }
  result.action = scanner.field('action');
  result.replyTo = scanner.field('replyTo');
  result.stopped = scanner.stopped !== undefined;
  result.done = scanner.done;
  return result;
}

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/** 相邻两段增量之间没有拆开代理对。 */
function pairsKept(deltas: readonly string[]): boolean {
  for (let i = 1; i < deltas.length; i += 1) {
    const before = deltas[i - 1] as string;
    const after = deltas[i] as string;
    if (isHigh(before.charCodeAt(before.length - 1)) && isLow(after.charCodeAt(0))) return false;
  }
  return true;
}

/** 整段送入、在每一个位置切成两段、逐个 UTF-16 码元送入。 */
function splits(text: string): string[][] {
  const out: string[][] = [[text], [...text.split('')]];
  for (let i = 0; i <= text.length; i += 1) out.push([text.slice(0, i), text.slice(i)]);
  return out;
}

/** 在每一种切法下，扫描的结果都与整段送入相同，且增量不拆开代理对。 */
function sameEverywhere(text: string): Scan {
  const whole = scan([text]);
  for (const chunks of splits(text)) {
    const result = scan(chunks);
    assert.ok(pairsKept(result.deltas), `代理对被拆开：${JSON.stringify(chunks)}`);
    assert.deepEqual(
      { ...result, deltas: result.deltas.join('') },
      { ...whole, deltas: whole.deltas.join('') },
      JSON.stringify(chunks),
    );
  }
  return whole;
}

const str = (value: string): ScannedField => ({ kind: 'string', value });
const NULL: ScannedField = { kind: 'null' };
const OTHER: ScannedField = { kind: 'other' };

test('扫描器：样例输出在每一个切分点切开，结果都与整段一致', () => {
  const cases: Array<{
    name: string;
    output: string;
    text: string;
    atStart: Scan['atStart'];
    action?: ScannedField;
    replyTo?: ScannedField;
  }> = [
    {
      name: 'json_object 的典型输出',
      output: '{"action":"speak","replyTo":"c-d6","text":"你好呀！欢迎来到直播间。"}',
      text: '你好呀！欢迎来到直播间。',
      atStart: { action: str('speak'), replyTo: str('c-d6') },
    },
    {
      name: '闲聊：replyTo 为 null',
      output: '{"action":"speak","replyTo":null,"text":"今天天气不错"}',
      text: '今天天气不错',
      atStart: { action: str('speak'), replyTo: NULL },
    },
    {
      name: 'json_schema：按字母序输出全部字段，文本里有各种转义与 \\u 写的代理对',
      output: String.raw`{"action":"speak","decisionPoint":null,"durationSec":null,"memories":["m1","m\"2"],"options":null,"question":null,"reason":null,"replyTo":"c-1","text":"嗯\"引号\"\\反斜杠\/斜杠\n换行\t\b\f\r\u4f60\ud83d\ude00好\u00e9"}`,
      text: '嗯"引号"\\反斜杠/斜杠\n换行\t\b\f\r你😀好é',
      atStart: { action: str('speak'), replyTo: str('c-1') },
    },
    {
      name: '空白与缩进，嵌套的数组与对象里的字符串含引号与括号',
      output: `{\n  "action" : "speak" ,\r\n\t"meta": {"a": ["}", "]", "\\"", {"text": "嵌套的不算"}], "b": {}, "c": []},\n  "replyTo":"c-1",  "text" :  "外层"  \n}  \n`,
      text: '外层',
      atStart: { action: str('speak'), replyTo: str('c-1') },
    },
    {
      name: '原样写出的代理对（emoji）',
      output: '{"action":"speak","replyTo":null,"text":"🎉好耶👍🏻！"}',
      text: '🎉好耶👍🏻！',
      atStart: { action: str('speak'), replyTo: NULL },
    },
    {
      name: '数与字面量',
      output:
        '{"action":"vote","durationSec":-1.5e+3,"n":0,"m":10.25E-2,"t":true,"f":false,"replyTo":null,"text":"t"}',
      text: 't',
      atStart: { action: str('vote'), replyTo: NULL },
    },
    {
      name: 'replyTo 在 text 之后：文本开始时还不知道回应谁',
      output: '{"action":"speak","text":"先说","replyTo":"c-1"}',
      text: '先说',
      atStart: { action: str('speak') },
      replyTo: str('c-1'),
    },
    {
      name: '重复的键取最后一个；第二个 text 不吐',
      output:
        '{"action":"vote","action":"speak","replyTo":"a","replyTo":null,"text":"第一个","text":"第二个","action":"silence"}',
      text: '第一个',
      atStart: { action: str('speak'), replyTo: NULL },
      action: str('silence'),
    },
    {
      name: 'replyTo 不是字符串也不是 null；text 不是字符串时等后面的',
      output: '{"action":"speak","replyTo":5,"text":null,"text":"后面的"}',
      text: '后面的',
      atStart: { action: str('speak'), replyTo: OTHER },
    },
    {
      name: '键名里有转义',
      output: String.raw`{"\u0061ction":"speak","reply\u0054o":["c-1"],"te\u0078t":"x"}`,
      text: 'x',
      atStart: { action: str('speak'), replyTo: OTHER },
    },
  ];
  for (const sample of cases) {
    // 样例本身是合法 JSON，第一个 text 就是要吐的文本。
    assert.doesNotThrow(() => JSON.parse(sample.output), sample.name);
    const result = sameEverywhere(sample.output);
    assert.equal(result.stopped, false, sample.name);
    assert.equal(result.done, true, sample.name);
    assert.equal(result.deltas.join(''), sample.text, sample.name);
    assert.equal(result.starts, 1, sample.name);
    assert.equal(result.ends, 1, sample.name);
    assert.deepEqual(result.atStart, sample.atStart, sample.name);
    assert.deepEqual(result.action, sample.action ?? sample.atStart?.action, sample.name);
    assert.deepEqual(result.replyTo, sample.replyTo ?? sample.atStart?.replyTo, sample.name);
  }
});

test('扫描器：第一个非空白字符不是 {、或结构不合法时停止，之后不再吐出', () => {
  const cases: Array<{ output: string; text: string; starts: number }> = [
    { output: '```json\n{"action":"speak","replyTo":null,"text":"x"}\n```', text: '', starts: 0 },
    { output: '好的：{"action":"speak","text":"x"}', text: '', starts: 0 },
    { output: '[{"action":"speak","text":"x"}]', text: '', starts: 0 },
    { output: '\uFEFF{"action":"speak","text":"x"}', text: '', starts: 0 },
    { output: '{"action" "speak","text":"x"}', text: '', starts: 0 },
    { output: '{"action":"speak",,"text":"x"}', text: '', starts: 0 },
    { output: "{'action':'speak','text':'x'}", text: '', starts: 0 },
    { output: '{"n":01,"text":"x"}', text: '', starts: 0 },
    { output: '{"n":1.,"text":"x"}', text: '', starts: 0 },
    { output: '{"n":-,"text":"x"}', text: '', starts: 0 },
    { output: '{"t":tru,"text":"x"}', text: '', starts: 0 },
    { output: '{"a":[1,],"text":"x"}', text: '', starts: 0 },
    { output: '{"a":{"b":1,},"text":"x"}', text: '', starts: 0 },
    { output: '{"a":[1}],"text":"x"}', text: '', starts: 0 },
    // 文本里的错误：之前解码出的照样吐出，没有结束。
    { output: '{"text":"前半\\x后半"}', text: '前半', starts: 1 },
    { output: '{"text":"前半\\u12G4后半"}', text: '前半', starts: 1 },
    { output: '{"text":"前半\u0001后半"}', text: '前半', starts: 1 },
    { output: '{"text":"前半\n后半"}', text: '前半', starts: 1 },
    // 顶层对象之后还有内容。
    { output: '{"text":"完整"} 多余', text: '完整', starts: 1 },
    { output: '{"text":"完整"}{}', text: '完整', starts: 1 },
  ];
  for (const sample of cases) {
    // 扫描器停止的输出，整段解析也不会通过。
    assert.equal(parseIntent(sample.output).ok, false, sample.output);
    const result = sameEverywhere(sample.output);
    assert.equal(result.stopped, true, sample.output);
    assert.equal(result.deltas.join(''), sample.text, sample.output);
    assert.equal(result.starts, sample.starts, sample.output);
  }
  // 停止之后再送入也不吐出。
  const scanner = new IntentScanner();
  scanner.push('不是 JSON');
  assert.ok(scanner.stopped);
  assert.deepEqual(scanner.push('{"text":"x"}'), []);

  // 前后的空白不算错；没读完时既没停止也没结束。
  const padded = sameEverywhere(' \r\n\t{"text":"x"}\n ');
  assert.equal(padded.stopped, false);
  assert.equal(padded.done, true);
  const partial = scan(['{"action":"speak","text":"未完']);
  assert.deepEqual(
    [partial.stopped, partial.done, partial.deltas.join('')],
    [false, false, '未完'],
  );
});

test('扫描器：任意 JSON 对象、任意键序与空白、任意切分，吐出的文本与 JSON.parse 一致', () => {
  const field = (value: unknown): ScannedField =>
    typeof value === 'string' ? str(value) : value === null ? NULL : OTHER;
  const key = fc.oneof(
    fc.constantFrom('action', 'replyTo', 'memories', 'reason'),
    fc.string({ unit: 'binary', maxLength: 6 }),
  );
  const space = fc.constantFrom('', ' ', '\n  ', '\t', '\r\n');
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.tuple(key, fc.jsonValue({ maxDepth: 2 })), {
        selector: ([k]) => k,
        maxLength: 5,
      }),
      fc.nat(5),
      // 任意码点；或者由单独的代理、引号与反斜杠拼成（单独的代理由 JSON.stringify 写成 \u 转义）。
      fc.oneof(
        fc.string({ unit: 'binary', maxLength: 30 }),
        fc.string({ unit: fc.constantFrom('\ud83d', '\ude00', '"', '\\', '好'), maxLength: 12 }),
      ),
      space,
      fc.boolean(),
      fc.array(fc.nat(), { maxLength: 12 }),
      (entries, at, text, gap, ascii, cuts) => {
        const others = entries.filter(([k]) => k !== 'text');
        const index = Math.min(at, others.length);
        const all: Array<[string, unknown]> = [
          ...others.slice(0, index),
          ['text', text],
          ...others.slice(index),
        ];
        let output = `${gap}{${gap}${all
          .map(
            ([k, v]) => `${JSON.stringify(k)}${gap}:${gap}${JSON.stringify(v, null, gap ? 2 : 0)}`,
          )
          .join(`${gap},${gap}`)}${gap}}${gap}`;
        // 有时把非 ASCII 字符都写成 \u 转义（代理对写成两个转义）。
        if (ascii) {
          output = output.replace(
            /[\u0080-\uffff]/gu,
            (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
          );
        }
        const positions = [...new Set(cuts.map((n) => n % (output.length + 1)))].sort(
          (a, b) => a - b,
        );
        const chunks: string[] = [];
        let from = 0;
        for (const p of positions) {
          chunks.push(output.slice(from, p));
          from = p;
        }
        chunks.push(output.slice(from));
        const parsed = JSON.parse(output) as Record<string, unknown>;
        const result = scan(chunks);
        assert.equal(result.stopped, false);
        assert.equal(result.done, true);
        assert.equal(result.deltas.join(''), parsed.text);
        assert.ok(pairsKept(result.deltas));
        const before = new Map(all.slice(0, index));
        assert.deepEqual(result.atStart, {
          ...(before.has('action') ? { action: field(before.get('action')) } : {}),
          ...(before.has('replyTo') ? { replyTo: field(before.get('replyTo')) } : {}),
        });
        assert.deepEqual(result.action, 'action' in parsed ? field(parsed.action) : undefined);
        assert.deepEqual(result.replyTo, 'replyTo' in parsed ? field(parsed.replyTo) : undefined);
      },
    ),
    { seed: 20261027, numRuns: 300 },
  );
});

test('文本流：按送入的段逐段读出；以错误结束时丢弃没读出的部分并抛出；读取方停止后送入的忽略', async () => {
  const read = async (queue: TextQueue) => {
    const got: string[] = [];
    for await (const piece of queue) got.push(piece);
    return got;
  };

  const ok = new TextQueue();
  ok.push('你好');
  ok.push('');
  ok.push('呀');
  const reading = read(ok);
  ok.push('！');
  ok.end();
  ok.push('结束之后的不算');
  ok.fail(new Error('结束之后的不算'));
  assert.deepEqual(await reading, ['你好', '呀', '！']);
  assert.equal(ok.open, false);

  const failing = new TextQueue();
  const iterator = failing[Symbol.asyncIterator]();
  failing.push('第一句。');
  assert.deepEqual(await iterator.next(), { done: false, value: '第一句。' });
  const waiting = iterator.next();
  failing.push('没读出的');
  failing.fail(new Error('最终校验不通过'));
  await assert.rejects(waiting, /最终校验不通过/);
  await assert.rejects(iterator.next(), /最终校验不通过/);

  const failedEarly = new TextQueue();
  failedEarly.push('还没读');
  failedEarly.fail(new Error('出错'));
  await assert.rejects(read(failedEarly), /出错/);

  const closed = new TextQueue();
  const reader = closed[Symbol.asyncIterator]();
  const pending = reader.next();
  await reader.return?.();
  assert.deepEqual(await pending, { done: true, value: undefined });
  closed.push('停止之后的');
  assert.equal(closed.open, false);
  assert.deepEqual(await reader.next(), { done: true, value: undefined });
});
