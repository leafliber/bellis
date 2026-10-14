import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReplayLlmService } from '@bellis/director';
import { SpeechService } from '@bellis/speech';
import { played, speak, startChain } from './helpers.ts';

const hello = { atMs: 0, id: 'd1', viewer: 'v1', nickname: '小明', text: '主播你好' };
const reply = '谢谢你来！今天我们一起玩魔女审判。等会儿再聊。';

test('弹幕回复在句边界被定时播报抢占，只写回已经播出的句子', async () => {
  const world = await startChain({
    messages: [hello],
    outputs: [speak(reply, 'c-d1')],
    announcements: [{ id: 'hour', atMs: 1500, text: '整点提醒。' }],
  });
  try {
    await world.until(() => played(world).length === 2);
    const [first, second] = played(world);
    assert.equal(first?.source, 'danmaku-reply');
    assert.equal(first?.end, 'preempted');
    assert.equal(first?.heard, '谢谢你来！今天我们一起玩魔女审判。');
    assert.equal(second?.source, 'scheduled');
    assert.equal(second?.end, 'complete');
    assert.equal(second?.heard, '整点提醒。');
    // 第三句没有授权，也没有播出。
    assert.equal(
      world
        .events('intent.authorized')
        .filter((e) => (e.data as { key: string }).key.endsWith('#2')).length,
      0,
    );
  } finally {
    await world.close();
  }
});

test('声明可立即抢占的发言被打断时按播放游标截断，写回已播出部分的前缀', async () => {
  const world = await startChain({
    announcements: [{ id: 'urgent', atMs: 1800, text: '紧急提醒。' }],
  });
  try {
    void world.service(SpeechService).request({
      id: 'chatter-1',
      source: 'chatter',
      text: reply,
      expiresAt: 60_000,
      preempt: 'immediate',
      inputs: [],
      untrusted: false,
    });
    await world.until(() => played(world).length === 2);
    const [first, second] = played(world);
    assert.equal(first?.end, 'preempted');
    const fullTwo = '谢谢你来！今天我们一起玩魔女审判。';
    assert.ok(first?.heard.startsWith('谢谢你来！'));
    assert.ok((first?.heard.length ?? 0) > '谢谢你来！'.length, '第二句应已播出一部分');
    assert.ok(fullTwo.startsWith(first?.heard ?? 'x'), '写回应是已播出部分的前缀');
    assert.ok((first?.heard.length ?? 99) < fullTwo.length, '第二句没有播完');
    assert.equal(second?.heard, '紧急提醒。');
  } finally {
    await world.close();
  }
});

test('写回进入决策模型上下文的只有观众实际听到的部分', async () => {
  const world = await startChain({
    messages: [hello, { atMs: 9000, id: 'd2', viewer: 'v2', nickname: '小红', text: '刚才说什么' }],
    outputs: [speak(reply, 'c-d1'), speak('好的。', 'c-d2')],
    announcements: [{ id: 'hour', atMs: 1500, text: '整点提醒。' }],
  });
  try {
    await world.until(() => played(world).length === 3);
    const llm = world.service(ReplayLlmService);
    assert.deepEqual(llm.requests[1]?.context.heard, [
      '谢谢你来！今天我们一起玩魔女审判。',
      '整点提醒。',
    ]);
  } finally {
    await world.close();
  }
});

test('普通弹幕回复不抢占正在进行的发言', async () => {
  const world = await startChain({
    messages: [hello, { atMs: 500, id: 'd2', viewer: 'v2', nickname: '小红', text: '你好呀' }],
    outputs: [speak(reply, 'c-d1'), speak('你也好。', 'c-d2')],
  });
  try {
    await world.until(() => played(world).length === 2);
    const [first, second] = played(world);
    assert.equal(first?.end, 'complete');
    assert.equal(first?.heard, reply);
    assert.equal(second?.heard, '你也好。');
  } finally {
    await world.close();
  }
});

test('急停：Stage 立即截断，此后没有新的输出，切到安全场景', async () => {
  const world = await startChain({ messages: [hello], outputs: [speak(reply, 'c-d1')] });
  try {
    await world.run(1500);
    const report = world.safety.emergencyStop('操作员急停');
    await world.until(() => played(world).length === 1);
    assert.equal((await report).obs.ok, true);
    const [first] = played(world);
    assert.equal(first?.end, 'stopped');
    assert.ok(reply.startsWith(first?.heard ?? 'x'));
    assert.ok((first?.heard.length ?? 99) < reply.length);
    assert.equal(world.obs.currentScene, 'Safe');
    const authorized = world.events('intent.authorized').length;
    await world.run(5000);
    assert.equal(world.events('intent.authorized').length, authorized);
  } finally {
    await world.close();
  }
});

test('上下文里只有净化后的称呼与文本，没有原始昵称', async () => {
  const rawName = '小​明‮\u0007';
  const world = await startChain({
    messages: [{ atMs: 0, id: 'd1', viewer: 'v1', nickname: rawName, text: '你好\u0000‍呀' }],
    outputs: [speak('你好。', 'c-d1')],
  });
  try {
    await world.until(() => played(world).length === 1);
    const context = world.service(ReplayLlmService).requests[0]?.context;
    assert.ok(!JSON.stringify(context).includes(rawName));
    assert.deepEqual(
      context?.candidates.map((c) => [c.name, c.text]),
      [['小明', '你好呀']],
    );
    for (const c of context?.candidates ?? []) {
      assert.ok(!/[\p{Cc}\p{Cf}]/u.test(c.name + c.text), '不含控制字符与格式字符');
    }
  } finally {
    await world.close();
  }
});

test('非法的模型输出被丢弃，不产生发声', async () => {
  const world = await startChain({
    messages: [hello, { atMs: 3000, id: 'd2', viewer: 'v2', nickname: '小红', text: '在吗' }],
    outputs: [
      '不是 JSON',
      JSON.stringify({ action: 'speak', text: '回应不存在的人。', replyTo: 'c-nobody' }),
    ],
  });
  try {
    await world.run(8000);
    assert.equal(played(world).length, 0);
    const dropped = world.logs
      .filter((l) => l.event === 'director.output-dropped')
      .map((l) => l.fields.reason);
    assert.deepEqual(dropped, ['不是合法 JSON', '回应对象 c-nobody 不在本次上下文中']);
  } finally {
    await world.close();
  }
});
