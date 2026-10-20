import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkHistory, checkVotes, type TraceEntry, World } from '../src/index.ts';
import { type ChainOptions, chain, played, startChain } from './helpers.ts';

const hello = { atMs: 0, id: 'd1', viewer: 'v1', nickname: '小明', text: '主播你好' };
const vote = (options: string[], durationSec = 20) =>
  JSON.stringify({ action: 'vote', question: '下一把玩什么', options, durationSec });
const ballot = (atMs: number, viewer: string, text: string) => ({
  atMs,
  id: `b${atMs}`,
  viewer,
  nickname: viewer,
  text,
});

/** 投票的发言（开票说明与结果）：去重键带投票编号。 */
const voteUtterances = (world: World) => played(world).filter((p) => p.id.startsWith('vote:'));
const begun = (trace: readonly TraceEntry[], suffix: string) =>
  trace.filter((e) => e.kind === 'page.begin' && String(e.data.sentenceId).includes(suffix));

test('决策模型发起投票：开票说明与结果各在 Stage 上播一次，按冻结的规则计票', async () => {
  const world = await startChain({
    messages: [
      hello,
      ballot(15_000, 'v1', '1'),
      ballot(15_500, 'v2', '逆转裁判'),
      ballot(16_000, 'v3', '１'),
      ballot(16_500, 'v1', '2'),
      ballot(17_000, 'v4', '我投魔女审判'),
    ],
    outputs: [vote(['魔女审判', '逆转裁判'])],
    vote: {},
  });
  try {
    await world.until(() => world.events('vote.ended').length === 1, 120_000);
    await world.until(() => voteUtterances(world).length === 2, 60_000);
    const [opening, result] = voteUtterances(world);
    assert.equal(opening?.source, 'danmaku-reply');
    assert.equal(opening?.end, 'complete');
    assert.equal(
      opening?.heard,
      '投票开始！下一把玩什么？1是「魔女审判」，2是「逆转裁判」。发弹幕打编号或者选项就算一票，每人只算第一票，二十秒后截止。',
    );
    assert.equal(result?.source, 'vote-result');
    assert.equal(result?.heard, '投票结束！「魔女审判」以两票胜出，一共三票。');
    const ended = world.events('vote.ended')[0]?.data as Record<string, unknown>;
    assert.deepEqual(ended.counts, [2, 1]);
    // 开票前到达的“主播你好”不在投票时段里；“我投魔女审判”不匹配；v1 改投不算。
    assert.deepEqual(ended.ignored, { unmatched: 1, repeat: 1, late: 0 });
    assert.ok(
      world.logs.some((l) => l.event === 'director.vote-started'),
      '决策插件记下开票成功',
    );
    await world.run(5000);
    assert.equal(begun(world.trace, ':result#0').length, 1);
    assert.equal(begun(world.trace, ':opening#0').length, 1);
    const history = { trace: world.trace, events: world.events(), moderationEnabled: true };
    assert.deepEqual(checkHistory(history), []);
  } finally {
    await world.close();
  }
});

test('审核启用时开票说明里有一句被拦下：投票中止，不出结果、不播报', async () => {
  const world = await startChain({
    messages: [hello],
    outputs: [vote(['禁词游戏', '正常游戏'])],
    moderation: { enabled: true, blocked: ['禁词'] },
    vote: {},
  });
  try {
    await world.until(() => world.events('vote.aborted').length === 1, 120_000);
    const aborted = world.events('vote.aborted')[0]?.data as Record<string, unknown>;
    assert.equal(aborted.cause, 'opening');
    await world.run(40_000);
    assert.equal(world.events('vote.ended').length, 0);
    assert.deepEqual(
      voteUtterances(world).map((u) => u.id.split(':').at(-1)),
      ['opening'],
    );
  } finally {
    await world.close();
  }
});

test('已有投票时模型再发起被拒并记日志；没有投票插件时只记日志', async () => {
  const world = await startChain({
    messages: [hello, { ...hello, atMs: 500, id: 'd2', viewer: 'v2', text: '再来一个' }],
    outputs: [vote(['魔女审判', '逆转裁判']), vote(['雀魂', '原神'])],
    vote: {},
  });
  try {
    await world.until(() => world.logs.some((l) => l.event === 'director.vote-refused'), 30_000);
    const refused = world.logs.find((l) => l.event === 'director.vote-refused');
    assert.match(String(refused?.fields.reason), /^已有进行中的投票 /);
    assert.equal(world.events('vote.rejected').length, 1);
    assert.equal(world.events('vote.started').length, 1);
  } finally {
    await world.close();
  }

  const without = await startChain({ messages: [hello], outputs: [vote(['a', 'b'])] });
  try {
    await without.until(
      () => without.logs.some((l) => l.event === 'director.vote-unavailable'),
      30_000,
    );
    assert.equal(without.events('vote.started').length, 0);
  } finally {
    await without.close();
  }
});

/** 在同一个状态存储上启动一个世界；重启后由操作员结案结果未知的句子（与仿真一样），再切回 M0。 */
async function boot(
  options: ChainOptions & { storePath: string; bootId: string; startAt?: number },
) {
  const world = new World({
    entries: chain(options),
    moderationEnabled: true,
    storePath: options.storePath,
    bootId: options.bootId,
    ...(options.startAt === undefined ? {} : { startAt: options.startAt }),
  });
  world.record('world.start', {});
  await world.kernel.settled();
  for (const intent of world.store.intentsIn('unknown')) {
    world.store.resolve(intent.id, { ok: false, error: '测试：操作员确认未播出' }, 'operator');
  }
  const mode = world.safety.requestMode('M0');
  if (!mode.ok) throw new Error(mode.reason);
  return world;
}

for (const [name, crashWhen, expectEnded] of [
  ['倒计时中', (w: World) => w.events('vote.announced').length === 1, false],
  ['结果播报中', (w: World) => begun(w.trace, ':result#0').length === 1, true],
] as const) {
  test(`重启：${name}强制结束宿主，重启后不重复开票、不重复播报`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bellis-vote-'));
    const storePath = join(dir, 'state.db');
    const trace: TraceEntry[] = [];
    try {
      const first = await boot({
        storePath,
        bootId: 'b0',
        messages: [hello, ballot(14_000, 'v1', '1')],
        outputs: [vote(['魔女审判', '逆转裁判'], 10)],
        vote: {},
      });
      await first.until(() => crashWhen(first), 120_000);
      trace.push(...first.trace);
      const { now } = first.crash();
      const second = await boot({ storePath, bootId: 'b1', startAt: now, vote: {} });
      try {
        await second.run(60_000);
        trace.push(...second.trace);
        const events = second.events();
        const facts = (type: string) => events.filter((e) => e.type === type);
        assert.equal(facts('vote.started').length, 1, '只开过一次票');
        assert.equal(facts('vote.ended').length, expectEnded ? 1 : 0);
        assert.deepEqual(
          facts('vote.aborted').map((e) => (e.data as { cause: string }).cause),
          expectEnded ? [] : ['restart'],
        );
        // 新进程里没有任何投票的发言开始播出。
        assert.equal(
          second.trace.filter(
            (e) => e.kind === 'page.begin' && String(e.data.sentenceId).startsWith('vote:'),
          ).length,
          0,
        );
        assert.deepEqual(checkVotes({ trace, events, moderationEnabled: true }), []);
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
