import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safetyFacade } from '@bellis/safety';
import { SpeechService } from '@bellis/speech';
import { played, startChain } from './helpers.ts';

const say = (id: string, text: string, preempt: 'sentence' | 'immediate' = 'sentence') => ({
  id,
  source: 'chatter' as const,
  text,
  expiresAt: 60_000,
  preempt,
  inputs: [],
  untrusted: false,
});

test('TTS 在句中出错不会卡住嘴：这一句截断，后面的发言照常播出', async () => {
  const world = await startChain({ tts: { failOn: ['坏音'] } });
  try {
    const speech = world.service(SpeechService);
    void speech.request(say('a', '这句有坏音。'));
    void speech.request(say('b', '这句正常。'));
    await world.until(() => played(world).length === 2, 20_000);
    const [a, b] = played(world);
    assert.equal(a?.end, 'stopped');
    assert.match(a?.reason ?? '', /音频流出错/);
    assert.equal(b?.heard, '这句正常。');
  } finally {
    await world.close();
  }
});

test('下一句还在审核时被抢占，这一句不再播出', async () => {
  const world = await startChain({
    moderation: { enabled: true, delayMs: 400 },
    announcements: [{ id: 'urgent', atMs: 1600, text: '插播。' }],
  });
  try {
    // 第一句 5 个码点约 1 秒；第二句在约 1.4 秒到 1.8 秒之间审核，插播在 1.6 秒到达。
    void world
      .service(SpeechService)
      .request(say('c', '谢谢你来！今天我们一起玩魔女审判。', 'immediate'));
    await world.until(() => played(world).length === 2, 20_000);
    const [chatter, urgent] = played(world);
    assert.equal(chatter?.end, 'preempted');
    assert.equal(chatter?.heard, '谢谢你来！');
    assert.equal(urgent?.heard, '插播。');
  } finally {
    await world.close();
  }
});

test('软收尾：尚未开始的句子不再播出', async () => {
  const world = await startChain({ moderation: { enabled: true, delayMs: 300 } });
  try {
    const speech = world.service(SpeechService);
    // 第一句约 0.3–1.1 秒播出；第二句在约 1.1–1.4 秒审核，此时软收尾。
    void speech.request(say('d', '第一句。第二句。'));
    await world.run(1200);
    speech.softStop('操作员收尾');
    await world.until(() => played(world).length === 1, 20_000);
    assert.equal(played(world)[0]?.heard, '第一句。');
  } finally {
    await world.close();
  }
});

test('许可时长短于默认续约间隔时，按时长续约，发言不被页面当作过期截断', async () => {
  const world = await startChain({
    safety: { leaseTtlMs: { 'stage.audio': 300, 'game.input': 500 } },
  });
  try {
    void world.service(SpeechService).request(say('e', '这一句比许可时长长得多。'));
    await world.until(() => played(world).length === 1, 20_000);
    assert.equal(played(world)[0]?.end, 'complete');
  } finally {
    await world.close();
  }
});

test('门面绑定实例：不能续约或交还其他实例持有的许可', async () => {
  const world = await startChain();
  try {
    const speechInstance = world.kernel.snapshot().find((e) => e.id === 'speech')
      ?.instanceId as string;
    const own = safetyFacade(world.safety, speechInstance).grant('stage.audio');
    assert.ok(own.ok);
    const intruder = safetyFacade(world.safety, 'triage#1');
    assert.deepEqual(intruder.renew(own.lease), { ok: false, reason: '不是本实例持有的许可' });
    intruder.release(own.lease);
    assert.ok(world.safety.leases.isValid('stage.audio', own.lease.token));
    assert.equal(intruder.grant('stage.audio').ok, false);
  } finally {
    await world.close();
  }
});
