import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { SseError, type SseEvent, SseParser } from '../src/index.ts';
import { arkReasoningStream, messyStream, openAiToolStream } from './fixtures.ts';

function parse(parts: readonly string[], max = 65_536) {
  const events: SseEvent[] = [];
  const parser = new SseParser(max, (event) => events.push(event));
  for (const part of parts) parser.push(part);
  parser.end();
  return { events, comments: parser.comments };
}

test('事件流：注释、多行 data、CRLF 与单独的 CR、event/id/retry 字段、最后一个事件没有空行', () => {
  const { events, comments } = parse(messyStream());
  assert.equal(comments, 3);
  assert.deepEqual(
    events.map((e) => e.type),
    ['message', 'message', 'message', 'message', 'message'],
  );
  // 两行 data 以 LF 连接，仍是合法 JSON。
  assert.ok(events[0]?.data.includes('\n'));
  for (const e of events.slice(0, 4)) JSON.parse(e.data);
  assert.equal(events[4]?.data, '[DONE]');
});

test('字段的写法：冒号后去掉一个空格；没有冒号的行是字段名；空 data 不分发；event 只作用于本事件', () => {
  const { events } = parse([
    'data:  两个空格\n\n',
    'data\n\n',
    'data:\n\n',
    'event: error\ndata: {"error":{}}\n\n',
    'data: 之后\n\n',
    'unknown: x\nid\nretry: 1\n\n',
  ]);
  assert.deepEqual(events, [
    { type: 'message', data: ' 两个空格' },
    { type: 'error', data: '{"error":{}}' },
    { type: 'message', data: '之后' },
  ]);
});

test('任意切分（含 CR 与 LF 分在两次送入）得到同样的事件', () => {
  for (const fixture of [arkReasoningStream(), openAiToolStream(), messyStream()]) {
    const whole = fixture.join('');
    const expected = parse([whole]).events;
    fc.assert(
      fc.property(fc.array(fc.nat(whole.length), { maxLength: 40 }), (cuts) => {
        const points = [...new Set([0, ...cuts, whole.length])].sort((a, b) => a - b);
        const parts = points.slice(1).map((end, i) => whole.slice(points[i], end));
        assert.deepEqual(parse(parts).events, expected);
      }),
      { seed: 7, numRuns: 200 },
    );
    // 逐个字符送入。
    assert.deepEqual(parse([...whole]).events, expected);
  }
});

test('单行与单个事件超过上限即报错', () => {
  assert.throws(() => parse([`data: ${'x'.repeat(200)}\n\n`], 100), SseError);
  assert.throws(
    () => parse([`data: ${'x'.repeat(60)}\ndata: ${'y'.repeat(60)}\n\n`], 100),
    SseError,
  );
  // 注释同样算在一行的上限里。
  assert.throws(() => parse([`: ${'z'.repeat(200)}`], 100), SseError);
  assert.equal(parse([`data: ${'x'.repeat(90)}\n\n`], 100).events.length, 1);
});
