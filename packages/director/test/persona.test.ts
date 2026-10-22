import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Memory, MemoryPersona, RecallResult } from '@bellis/memory';
import {
  choosePersona,
  DEFAULT_DRIFT_PHRASES,
  TEST_PERSONA,
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
} from '../src/index.ts';
import { candidate, silence, world } from './helpers.ts';

const PROFILE = '（profile 里的人设）你是测试用的角色。';
const IRIS: MemoryPersona = { text: '你是贝莉，Iris 里由维护者确认的人设。', version: 3 };

/** 记忆服务：召回由测试决定何时、以什么结果结束；`persona` 是它记住的 Iris 人设。 */
function memoryWith(persona: MemoryPersona | undefined) {
  const state = { persona };
  const pending: Array<(result: RecallResult) => void> = [];
  const memory: Memory = {
    recall: () => new Promise((resolve) => pending.push(resolve)),
    feedback() {},
    check: async () => {},
    get persona() {
      return state.persona;
    },
    currentPersona: async () => state.persona,
    report: { ready: true, status: '就绪', pending: 0, written: 0, dropped: 0, tombstones: 0 },
  };
  return { memory, state, pending };
}

/** 数据区（分隔标记之间）与其余部分。 */
function split(user: string) {
  const start = user.indexOf(UNTRUSTED_OPEN) + UNTRUSTED_OPEN.length;
  const zone = user.slice(start, user.indexOf(UNTRUSTED_CLOSE, start));
  return { zone, outside: user.replace(zone, '') };
}

test('启用记忆、拿到过 Iris 的人设：系统消息用它并标明版本；人设不在不可信数据区；来源与版本记日志，不记正文', async () => {
  const fake = memoryWith(IRIS);
  const w = await world({ memory: fake.memory, config: { persona: PROFILE } });
  try {
    await w.arrive(candidate({ id: 'c-a' }));
    fake.pending[0]?.({ ok: true, recall: { recallId: 'r1', memories: [] } });
    await w.flush();
    const { request } = w.call(0);
    const [system, user] = request.messages;
    assert.ok(system?.content.includes(IRIS.text));
    assert.ok(system?.content.includes('Iris 的当前人设，第 3 版，由维护者确认'));
    assert.ok(!system?.content.includes(PROFILE), '不用 profile 的人设');
    assert.ok(!(user?.content ?? '').includes(IRIS.text), '人设不在用户消息里，更不在不可信数据区');
    assert.equal(request.context.persona, IRIS.text);
    assert.deepEqual(request.context.personaSource, { from: 'iris', version: 3 });
    assert.deepEqual(w.logged('director.persona'), [{ source: 'iris', version: 3 }]);
    assert.ok(!JSON.stringify(w.logs).includes(IRIS.text), '日志不写人设正文');
    w.call(0).resolve(silence);
    await w.flush();

    // Iris 的人设换了版本：下一次决策就用新的，日志记一次变化。
    fake.state.persona = { text: '你是贝莉，第四版。', version: 4 };
    await w.arrive(candidate({ id: 'c-b' }));
    fake.pending[1]?.({ ok: true, recall: { recallId: 'r2', memories: [] } });
    await w.flush();
    assert.ok(w.call(1).request.messages[0]?.content.includes('第 4 版'));
    assert.deepEqual(w.logged('director.persona'), [
      { source: 'iris', version: 3 },
      { source: 'iris', version: 4 },
    ]);
  } finally {
    await w.close();
  }
});

test('召回超时：用记忆插件缓存的人设（最近一次拿到的）', async () => {
  const fake = memoryWith(IRIS);
  const w = await world({
    memory: fake.memory,
    config: { persona: PROFILE, recallTimeoutMs: 1_000 },
  });
  try {
    await w.arrive(candidate({ id: 'c-a' }));
    assert.equal(w.calls.length, 0);
    await w.advance(1_010);
    assert.equal(w.calls.length, 1, '到截止时间不带记忆继续');
    const [system] = w.call(0).request.messages;
    assert.ok(system?.content.includes(IRIS.text));
    assert.ok(system?.content.includes('第 3 版'));
    assert.deepEqual(w.logged('director.recall-skipped'), [{ kind: 'timeout' }]);
  } finally {
    await w.close();
  }
});

test('从未拿到过 Iris 的人设（或记忆插件不在场）：回退到 profile 的人设', async () => {
  const fake = memoryWith(undefined);
  const w = await world({ memory: fake.memory, config: { persona: PROFILE } });
  try {
    await w.arrive(candidate({ id: 'c-a' }));
    fake.pending[0]?.({ ok: false, kind: 'error', detail: 'not_found，HTTP 404' });
    await w.flush();
    const { request } = w.call(0);
    assert.ok(request.messages[0]?.content.includes(PROFILE));
    assert.ok(request.messages[0]?.content.includes('由操作员设定'));
    assert.equal(request.context.personaSource, undefined);
    assert.deepEqual(w.logged('director.persona'), [{ source: 'profile', version: null }]);
    const { zone, outside } = split(request.messages[1]?.content ?? '');
    assert.ok(!zone.includes(PROFILE) && !outside.includes(PROFILE));
  } finally {
    await w.close();
  }
  assert.deepEqual(choosePersona(undefined, PROFILE), {
    text: PROFILE,
    source: 'profile',
    version: null,
  });
});

test('测试人设：贝莉，温和爱聊天；写明不谈真实人物、政治、宗教，不给医疗与投资建议；不自称语言模型', () => {
  assert.ok(TEST_PERSONA.includes('贝莉'));
  for (const word of ['温和', '爱聊天', '真实人物', '政治', '宗教', '医疗', '投资']) {
    assert.ok(TEST_PERSONA.includes(word), word);
  }
  for (const word of ['语言模型', '模型', 'AI', '人工智能', '助手']) {
    assert.ok(!TEST_PERSONA.includes(word), word);
  }
  // 人设本身不会命中出戏用语。
  for (const phrase of DEFAULT_DRIFT_PHRASES) assert.ok(!TEST_PERSONA.includes(phrase), phrase);
});
