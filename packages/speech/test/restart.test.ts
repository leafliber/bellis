import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INTERRUPTED_SPEECH, interruptedSpeech, SPEECH_INTENT } from '../src/index.ts';

const speech = {
  type: SPEECH_INTENT.type,
  target: SPEECH_INTENT.target,
  capabilities: [SPEECH_INTENT.capability],
  timeSensitive: true,
};

test('重启时自动结案的只有 Stage 的发言意图：类型、目标、能力与时效都对上', () => {
  assert.equal(interruptedSpeech(speech), INTERRUPTED_SPEECH);
  assert.equal(INTERRUPTED_SPEECH, '重启中断：播出多少不可知，不重做');
  for (const other of [
    { ...speech, type: 'vote.start' },
    { ...speech, target: 'obs:Stage' },
    { ...speech, capabilities: ['speech.output', 'obs.scene'] },
    { ...speech, capabilities: [] },
    { ...speech, timeSensitive: false },
    {
      type: 'memory.write',
      target: 'iris:room',
      capabilities: ['memory.write'],
      timeSensitive: false,
    },
  ]) {
    assert.equal(interruptedSpeech(other), undefined, JSON.stringify(other));
  }
});
