import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seededRandom } from '@bellis/kernel';
import { formatTraceparent, newSpanId, newTraceId, parseTraceparent } from '../src/index.ts';

const VALID = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

test('traceparent：生成与解析互逆，版本 00，sampled 取 flags 的最低位', () => {
  assert.deepEqual(parseTraceparent(VALID), {
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    spanId: '00f067aa0ba902b7',
    sampled: true,
  });
  assert.equal(parseTraceparent(VALID.replace(/01$/, '00'))?.sampled, false);
  assert.equal(parseTraceparent(VALID.replace(/01$/, '03'))?.sampled, true);
  const context = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: true };
  assert.equal(formatTraceparent(context), `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
  assert.deepEqual(parseTraceparent(formatTraceparent(context)), context);
});

test('traceparent：更高版本只读前四段，其后须以 - 隔开', () => {
  assert.equal(
    parseTraceparent(`cc${VALID.slice(2)}`)?.traceId,
    '4bf92f3577b34da6a3ce929d0e0e4736',
  );
  assert.ok(parseTraceparent(`cc${VALID.slice(2)}-what-the-future-will-be-like`));
  assert.equal(parseTraceparent(`cc${VALID.slice(2)}x`), undefined);
});

test('traceparent：拒绝不合格的输入', () => {
  for (const bad of [
    undefined,
    null,
    42,
    {},
    '',
    'not a traceparent',
    // 版本 00 不能有多余的部分
    `${VALID}-extra`,
    // 版本 ff 不合法
    `ff${VALID.slice(2)}`,
    // 全零的 trace-id 与 parent-id
    `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`,
    `00-4bf92f3577b34da6a3ce929d0e0e4736-${'0'.repeat(16)}-01`,
    // 大写、长度不对、非十六进制、分隔符不对
    VALID.toUpperCase(),
    '00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01',
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b-01',
    '00-4bf92f3577b34da6a3ce929d0e0e473g-00f067aa0ba902b7-01',
    '00_4bf92f3577b34da6a3ce929d0e0e4736_00f067aa0ba902b7_01',
    '0-04bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    ` ${VALID}`,
  ]) {
    assert.equal(parseTraceparent(bad), undefined, String(bad));
  }
});

test('trace ID 与 span ID 由随机数服务生成：同一种子得到同一序列，长度与字符合格', () => {
  const a = seededRandom(7);
  const b = seededRandom(7);
  const ids = [newTraceId(a), newSpanId(a), newTraceId(a)];
  assert.deepEqual([newTraceId(b), newSpanId(b), newTraceId(b)], ids);
  assert.match(ids[0] as string, /^[0-9a-f]{32}$/);
  assert.match(ids[1] as string, /^[0-9a-f]{16}$/);
  assert.notEqual(ids[0], ids[2]);
  // 全零时重取。
  let calls = 0;
  const zeros = { next: () => 0, int: () => (calls++ < 4 ? 0 : 1) };
  assert.equal(newSpanId(zeros), '0001000100010001');
});
