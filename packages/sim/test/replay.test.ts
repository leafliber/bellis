import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DanmakuService, type DanmakuSource } from '@bellis/audience';
import { World } from '../src/index.ts';
import { entry } from './helpers.ts';

const messages = [
  { atMs: 100, id: 'd1', viewer: 'v1', nickname: '小明', text: '主播你好' },
  { atMs: 300, id: 'd2', viewer: 'v2', nickname: '小红', text: '今天玩什么' },
];

function replayWorld(startOn: 'activation' | 'output', simulation: boolean) {
  return new World({
    entries: [entry('danmaku', 'danmaku-replay', { config: { messages, startOn } })],
    moderationEnabled: false,
    safety: { simulation },
  });
}

const delivered = (world: World) =>
  world.trace.filter((e) => e.kind === 'danmaku.delivered').map((e) => [e.at, e.data.id]);

test('回放从第一次进入真实输出模式时开始计时：之前不送出，之后按偏移送出，模式再变也不暂停', async () => {
  const world = replayWorld('output', false);
  try {
    await world.kernel.settled();
    const source = world.service(DanmakuService) as DanmakuSource;
    assert.equal(source.ready, true);
    assert.match(source.status ?? '', /进入真实输出模式后开始/);
    await world.run(5000);
    assert.deepEqual(delivered(world), []);

    world.safety.confirmPresence();
    assert.ok(world.safety.requestMode('M2').ok);
    const startedAt = world.clock.now();
    assert.equal(source.status, '回放');
    assert.deepEqual(
      world.logs.filter((l) => l.event === 'danmaku-replay.started').map((l) => l.fields.messages),
      [2],
    );
    await world.run(150);
    void world.safety.emergencyStop('测试急停');
    await world.run(500);
    assert.deepEqual(delivered(world), [
      [startedAt + 100, 'd1'],
      [startedAt + 300, 'd2'],
    ]);
  } finally {
    await world.close();
  }
});

test('缺省从插件激活时开始计时；M0 不算真实输出模式', async () => {
  const fromActivation = replayWorld('activation', true);
  const waiting = replayWorld('output', true);
  try {
    await fromActivation.kernel.settled();
    await waiting.kernel.settled();
    assert.ok(waiting.safety.requestMode('M0').ok);
    await fromActivation.run(500);
    await waiting.run(500);
    assert.deepEqual(delivered(fromActivation), [
      [100, 'd1'],
      [300, 'd2'],
    ]);
    assert.deepEqual(delivered(waiting), []);
  } finally {
    await fromActivation.close();
    await waiting.close();
  }
});
