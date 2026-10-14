import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAction } from '../src/index.ts';

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
  ]) {
    assert.equal(parseAction(bad).ok, false, bad);
  }
});
