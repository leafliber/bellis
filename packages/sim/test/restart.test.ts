import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SimIrisBackend } from '@bellis/memory';
import { INTERRUPTED_SPEECH, SpeechService } from '@bellis/speech';
import type { StoredEvent } from '@bellis/store';
import {
  checkRecovery,
  SAMPLE_RATE,
  SAMPLES_PER_CHAR,
  type Scenario,
  simulate,
  type World,
} from '../src/index.ts';
import { played, startChain } from './helpers.ts';

const say = (id: string, text: string) => ({
  id,
  source: 'chatter' as const,
  text,
  expiresAt: 600_000,
  preempt: 'sentence' as const,
  inputs: [],
  untrusted: false,
});

const begun = (world: World, prefix: string) =>
  world.trace.some((e) => e.kind === 'page.begin' && String(e.data.sentenceId).startsWith(prefix));

test('真实状态存储上播出中强制结束、重启：那一句自动结案，Stage 不再隔离，之后的发言照常授权并播出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bellis-restart-'));
  const storePath = join(dir, 'state.db');
  const tts = { sampleRate: SAMPLE_RATE, samplesPerChar: SAMPLES_PER_CHAR };
  try {
    const first = await startChain({
      moderation: { enabled: false },
      tts,
      storePath,
      bootId: 'b0',
    });
    void first.service(SpeechService).request(say('a', '第一句先说。第二句接着说。第三句。'));
    await first.until(() => begun(first, 'a#1'));
    await first.run(300);
    const executing = first.store.intentsIn('executing').map((i) => i.key);
    assert.deepEqual(executing, ['a#1']);
    const { now } = first.crash();

    const second = await startChain({
      moderation: { enabled: false },
      tts,
      storePath,
      bootId: 'b1',
      startAt: now,
    });
    try {
      // 恢复时那一句先标为结果未知，再当场结案；没有剩下结果未知的意图。
      const events = second.events();
      const interrupted = events.filter((e) => e.type === 'intent.interrupted');
      const orphaned = events.find((e) => e.type === 'intent.orphaned');
      assert.ok(orphaned);
      assert.deepEqual(
        interrupted.map((e) => e.data),
        [
          {
            id: (orphaned.data as { id: number }).id,
            key: 'a#1',
            target: 'stage',
            error: INTERRUPTED_SPEECH,
          },
        ],
      );
      assert.deepEqual(second.store.intentsIn('unknown'), []);
      // 被打断的发言在两个进程里都没有写回，也没有重播。
      assert.ok(!played(second).some((u) => u.id === 'a'));
      assert.ok(!begun(second, 'a#'));

      void second.service(SpeechService).request(say('b', '重启之后照常说话。'));
      await second.until(() => played(second).length === 1);
      assert.deepEqual(
        played(second).map((u) => [u.id, u.end, u.heard]),
        [['b', 'complete', '重启之后照常说话。']],
      );
      assert.ok(
        !second
          .events('intent.denied')
          .some((e) => String((e.data as { reason: string }).reason).includes('隔离')),
      );
    } finally {
      await second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('其它目标的结果未知意图（所有者不在场）：结案前目标隔离、新的意图被拒，操作员结案后照常授权', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bellis-restart-'));
  const storePath = join(dir, 'state.db');
  const backend = new SimIrisBackend();
  try {
    // 记忆插件的写入在途时崩溃。
    const first = await startChain({
      moderation: { enabled: false },
      storePath,
      bootId: 'b0',
      messages: [{ atMs: 0, id: 'd1', viewer: 'v1', nickname: '小明', text: '主播你好' }],
      memory: { iris: { writeDelayMs: 60_000 }, config: { write: { flushDelayMs: 100 } }, backend },
    });
    await first.until(() =>
      first.store.intentsIn('executing').some((i) => i.type === 'memory.write'),
    );
    const { now } = first.crash();

    // 重启时没有启用记忆：没有所有者对账，写入意图一直结果未知。
    const second = await startChain({
      moderation: { enabled: false },
      storePath,
      bootId: 'b1',
      startAt: now,
    });
    try {
      const [unknown] = second.store.intentsIn('unknown');
      assert.equal(unknown?.type, 'memory.write');
      // 以在场的插件实例申请一个不要能力的意图：闸门依次核对到“目标没有结果未知的意图”这一项。
      const holder = second.kernel.snapshot().find((e) => e.id === 'speech')?.instanceId ?? '';
      const request = {
        holder,
        key: 'memory.write:retry',
        type: 'memory.write',
        target: unknown?.target ?? '',
        payload: {},
        source: { origin: 'test', inputs: [], untrusted: false },
        capabilities: [],
        timeSensitive: false,
      };
      const before = await second.safety.authorize(request);
      assert.equal(before.allowed, false);
      assert.match(before.allowed ? '' : before.reason, /结果未知的意图，已隔离/);
      // 发言不受影响。
      void second.service(SpeechService).request(say('b', '照常说话。'));
      await second.until(() => played(second).length === 1);
      assert.equal(played(second)[0]?.end, 'complete');

      second.store.resolve(unknown?.id ?? 0, { ok: false, error: '操作员结案' }, 'operator');
      assert.deepEqual(second.store.intentsIn('unknown'), []);
      const after = await second.safety.authorize({ ...request, key: 'memory.write:retry-2' });
      assert.equal(after.allowed, true);
      assert.deepEqual(
        second.events('intent.reconciled').map((e) => (e.data as { by: string }).by),
        ['operator'],
      );
    } finally {
      await second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('仿真：真实输出模式下播出中崩溃重启，发言自动结案，之后的发言在新进程里照常播出', async () => {
  const scenario: Scenario = {
    seed: 3,
    moderation: { enabled: false, onError: 'pass', delayMs: 0 },
    ttsSlow: true,
    danmaku: [{ atMs: 0, viewer: 1, nickname: 1, text: 1 }],
    outputs: [
      { kind: 'reply', sentences: [0, 1, 4], target: 1 },
      { kind: 'chatter', sentences: [5] },
    ],
    announcements: [{ atMs: 9000, sentences: [6], immediate: false }],
    operator: [{ atMs: 2000, action: 'restart' }],
    mode: 'M2',
    durationMs: 20_000,
  };
  const result = await simulate(scenario);
  assert.deepEqual(result.violations, []);
  const { trace, events } = result.history;
  assert.ok(events.some((e) => e.type === 'intent.interrupted'));
  const restartedAt = trace.findIndex((e) => e.kind === 'world.start' && e.data.restarts === 1);
  assert.ok(restartedAt > 0);
  // 重启后进入 M2，并有句子在 Stage 上播出（定时播报与闲聊）。
  assert.ok(
    trace.slice(restartedAt).some((e) => e.kind === 'control.mode' && e.data.mode === 'M2'),
  );
  assert.ok(trace.slice(restartedAt).some((e) => e.kind === 'page.played'));
});

/** 合成的事实序列：只给 checkRecovery 看到的字段。 */
function history(list: Array<[string, Record<string, unknown>]>) {
  const events: StoredEvent[] = list.map(([type, data], i) => ({
    seq: i + 1,
    type,
    source: 'test',
    occurredAt: 0,
    recordedAt: 0,
    data,
  }));
  return { trace: [], events, moderationEnabled: false };
}

const speechAuthorized = (id: number): [string, Record<string, unknown>] => [
  'intent.authorized',
  { id, key: `u#${id}`, type: 'speech.play', target: 'stage', capabilities: ['speech.output'] },
];
const writeAuthorized = (id: number): [string, Record<string, unknown>] => [
  'intent.authorized',
  { id, key: `w${id}`, type: 'memory.write', target: 'iris:room', capabilities: ['memory.write'] },
];

test('重启与结案的不变量：抓得到没结案的发言、隔离中授权或执行、被隔离的发言与不该自动结案的意图', () => {
  assert.deepEqual(
    checkRecovery(
      history([
        speechAuthorized(1),
        ['intent.started', { id: 1 }],
        ['intent.orphaned', { id: 1, target: 'stage' }],
        ['intent.interrupted', { id: 1, target: 'stage' }],
        ['safety.started', {}],
        speechAuthorized(2),
      ]),
    ),
    [],
  );
  assert.match(
    checkRecovery(
      history([
        speechAuthorized(1),
        ['intent.orphaned', { id: 1, target: 'stage' }],
        ['safety.started', {}],
      ]),
    ).join(''),
    /发言意图 1 没有当场结案/,
  );
  const isolated = checkRecovery(
    history([
      writeAuthorized(1),
      ['intent.orphaned', { id: 1, target: 'iris:room' }],
      ['safety.started', {}],
      writeAuthorized(2),
      ['intent.started', { id: 2 }],
      ['intent.reconciled', { id: 1, by: 'operator' }],
      writeAuthorized(3),
    ]),
  );
  assert.equal(isolated.length, 2);
  assert.match(isolated[0] ?? '', /授权了意图 2/);
  assert.match(isolated[1] ?? '', /开始执行了意图 2/);
  assert.match(
    checkRecovery(
      history([
        writeAuthorized(1),
        ['intent.orphaned', { id: 1, target: 'iris:room' }],
        ['intent.interrupted', { id: 1, target: 'iris:room' }],
      ]),
    ).join(''),
    /不是重启时停在执行中的发言，却被自动结案/,
  );
  assert.match(
    checkRecovery(
      history([
        ['intent.denied', { target: 'stage', reason: '目标 stage 有结果未知的意图，已隔离' }],
      ]),
    ).join(''),
    /重启后发言没有恢复/,
  );
});
