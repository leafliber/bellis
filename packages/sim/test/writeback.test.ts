import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpeechService } from '@bellis/speech';
import { StageService } from '@bellis/stage';
import { checkHistory, SAMPLE_RATE, SAMPLES_PER_CHAR, type World } from '../src/index.ts';
import { played, startChain } from './helpers.ts';

/** 每个字 0.1 秒（16kHz、每字 1600 个采样），句末的句号不朗读。 */
const TEXT = '一二三四五六七八九十。';
const DELAY_MS = 300;
const CUT = (DELAY_MS * SAMPLE_RATE) / 1000;

/** 这一句已经播出的采样数（页面每拍回报的累计）。 */
function samples(world: World, sentenceId: string): number {
  return world.trace
    .filter((e) => e.kind === 'page.played' && e.data.sentenceId === sentenceId)
    .reduce((sum, e) => sum + Number(e.data.samples), 0);
}

function truncatedAt(world: World): number {
  const entry = world.trace.find((e) => e.kind === 'page.truncated');
  assert.ok(entry, '页面应回报截断');
  return Number(entry.data.played);
}

const prefix = (cursor: number) =>
  [...TEXT].slice(0, Math.floor(cursor / SAMPLES_PER_CHAR)).join('');

const clean = (world: World) =>
  checkHistory({ trace: world.trace, events: world.events(), moderationEnabled: true });

/** 一段可以被立即抢占的闲聊，播到第 7 个字的中途：扣掉 300ms 正好少 3 个字。 */
async function playing(delayMs: number) {
  const world = await startChain({
    tts: { samplesPerChar: SAMPLES_PER_CHAR, sampleRate: SAMPLE_RATE },
  });
  world.service(StageService).setPresentation({ delayMs, samples: 0, source: 'initial' });
  void world.service(SpeechService).request({
    id: 'count',
    source: 'chatter',
    text: TEXT,
    expiresAt: 60_000,
    preempt: 'immediate',
    inputs: [],
    untrusted: false,
  });
  await world.until(() => samples(world, 'count#0') >= 6 * SAMPLES_PER_CHAR + 800);
  return world;
}

test('急停且 OBS 应急静音成功：写回游标扣掉急停那一刻的呈现延迟', async () => {
  const world = await playing(DELAY_MS);
  try {
    const report = world.safety.emergencyStop('测试急停');
    await world.until(() => played(world).length === 1);
    assert.equal((await report).obs.ok, true);
    const cursor = truncatedAt(world);
    const [utterance] = played(world);
    assert.equal(utterance?.end, 'stopped');
    assert.equal(utterance?.heard, prefix(cursor - CUT));
    assert.ok((utterance?.heard.length ?? 0) < prefix(cursor).length, '比不扣时少');
    const log = world.logs.find((l) => l.event === 'speech.emergency-writeback');
    assert.deepEqual(
      [log?.fields.played, log?.fields.delayMs, log?.fields.cursor],
      [cursor, DELAY_MS, cursor - CUT],
    );
    assert.deepEqual(clean(world), []);
  } finally {
    await world.close();
  }
});

test('急停但 OBS 应急静音失败：交给 OBS 的声音照常呈现，写回不扣', async () => {
  const world = await playing(DELAY_MS);
  try {
    world.obs.ready = false;
    const report = world.safety.emergencyStop('测试急停');
    await world.until(() => played(world).length === 1);
    assert.equal((await report).obs.ok, false);
    const [utterance] = played(world);
    assert.equal(utterance?.heard, prefix(truncatedAt(world)));
    assert.equal(
      world.logs.some((l) => l.event === 'speech.emergency-writeback'),
      false,
    );
    assert.deepEqual(clean(world), []);
  } finally {
    await world.close();
  }
});

test('不是急停（被立即抢占、页面自己截断）：写回不扣；呈现延迟为 0 时急停也不扣', async () => {
  const world = await playing(DELAY_MS);
  try {
    void world.service(SpeechService).request({
      id: 'urgent',
      source: 'safety',
      text: '紧急。',
      expiresAt: 60_000,
      preempt: 'sentence',
      inputs: [],
      untrusted: false,
    });
    await world.until(() => played(world).length === 2);
    const [first] = played(world);
    assert.equal(first?.end, 'preempted');
    assert.equal(first?.heard, prefix(truncatedAt(world)));
    assert.deepEqual(clean(world), []);
  } finally {
    await world.close();
  }

  const still = await playing(0);
  try {
    void still.safety.emergencyStop('测试急停');
    await still.until(() => played(still).length === 1);
    assert.equal(played(still)[0]?.heard, prefix(truncatedAt(still)));
    assert.deepEqual(clean(still), []);
  } finally {
    await still.close();
  }
});
