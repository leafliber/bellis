import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DanmakuService } from '@bellis/audience';
import { LlmService } from '@bellis/director';
import { World } from '../src/index.ts';
import { entry } from './helpers.ts';

test('回放的弹幕接入与回放模型恒为就绪；回放的缺口照常经 gap() 报告', async () => {
  const world = new World({
    entries: [
      entry('danmaku', 'danmaku-replay', {
        config: { messages: [], gaps: [{ atMs: 100, durationMs: 200 }] },
      }),
      entry('llm', 'llm-replay', { config: { outputs: [] } }),
    ],
    moderationEnabled: false,
  });
  await world.kernel.settled();
  try {
    const danmaku = world.service(DanmakuService);
    const llm = world.service(LlmService);
    assert.equal(danmaku.ready, true);
    assert.equal(danmaku.status, '回放');
    assert.equal(llm.ready, true);
    assert.equal(llm.status, '回放');
    assert.equal(llm.probe, undefined, '回放模型没有探测');
    await world.run(150);
    assert.deepEqual(danmaku.gap?.(), { reason: '回放的缺口' });
    assert.equal(danmaku.ready, true);
  } finally {
    await world.close();
  }
});
