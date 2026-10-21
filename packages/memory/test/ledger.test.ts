import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StoredEvent } from '@bellis/store';
import {
  DEFAULT_PRIVACY_RULES,
  MemoryFact,
  type MemoryLedger,
  memoryLedger,
  normalizeForRules,
  PrivacyGateway,
  pseudonym,
  pseudonymCode,
  tombstoneFact,
  validAccount,
} from '../src/index.ts';

let seq = 0;
const event = (type: string, data: unknown): StoredEvent => {
  seq += 1;
  return { seq, type, source: 'safety', occurredAt: 1000 + seq, recordedAt: 1000 + seq, data };
};

const replay = (events: StoredEvent[]): MemoryLedger =>
  events.reduce((state, e) => memoryLedger.reduce(state, e), memoryLedger.initial);

const queued = (ref: string, account: string | null) =>
  event(MemoryFact.Queued, {
    kind: account === null ? 'self_output' : 'message',
    ref,
    account,
    sender: account === null ? '主播' : pseudonym(account),
    content: `内容${ref}`,
  });

test('记忆账本是纯函数：待发队列按事实进出，墓碑移除这名观众的条目且之后的不再进入；前缀只记一次', () => {
  const a = queued('d1', 'open-a');
  const b = queued('d2', 'open-b');
  const self = queued('u1', null);
  const events = [
    event(MemoryFact.Epoch, { id: 'aaaa' }),
    event(MemoryFact.Epoch, { id: 'bbbb' }),
    a,
    b,
    self,
    event(MemoryFact.Written, { seqs: [b.seq], messageIds: [7] }),
    event(MemoryFact.Tombstoned, { account: 'open-a', by: 'operator' }),
    queued('d3', 'open-a'),
    event(MemoryFact.Dropped, { seqs: [self.seq, 999], cause: 'overflow' }),
    // 不合格的事实忽略。
    event(MemoryFact.Queued, { kind: 'other', ref: 'x', account: null, sender: 's', content: 'c' }),
    event(MemoryFact.Tombstoned, { account: '有 空白' }),
  ];
  const state = replay(events);
  assert.equal(state.epoch, 'aaaa');
  assert.deepEqual(state.outbox, []);
  assert.deepEqual(state.tombstones, ['open-a']);
  assert.equal(state.written, 1);
  assert.equal(state.dropped, 1);
  // 同样的事件重放得到同样的状态（重启时重建）。
  assert.deepEqual(replay(events), state);
  const pending = replay([a, b]);
  assert.deepEqual(
    pending.outbox.map((item) => [item.seq, item.ref, item.account, item.at]),
    [
      [a.seq, 'd1', 'open-a', a.recordedAt],
      [b.seq, 'd2', 'open-b', b.recordedAt],
    ],
  );
});

test('墓碑的事实只认像样的平台 ID；代号由平台 ID 确定地派生', () => {
  assert.deepEqual(tombstoneFact('open-a'), {
    type: MemoryFact.Tombstoned,
    data: { account: 'open-a', by: 'operator' },
  });
  for (const bad of ['', ' ', 'a b', '中文', 'x'.repeat(129)]) {
    assert.equal(tombstoneFact(bad), undefined, bad);
    assert.equal(validAccount(bad), false, bad);
  }
  assert.equal(pseudonym('open-a'), `观众${pseudonymCode('open-a')}`);
  assert.equal(pseudonymCode('open-a'), pseudonymCode('open-a'));
  assert.notEqual(pseudonymCode('open-a'), pseudonymCode('open-b'));
  assert.match(pseudonymCode('open-a'), /^[0-9a-f]{8}$/);
});

test('隐私网关：缺省规则按类别命中，匹配前规范化（全角、空白、零宽、大小写）；不命中的通过', () => {
  const gateway = new PrivacyGateway(DEFAULT_PRIVACY_RULES);
  const cases: Array<[string, string[]]> = [
    ['我住在上海', ['location']],
    ['坐标成都', ['location']],
    ['我在复旦大学读书', ['location']],
    ['我感冒了', ['health']],
    ['刚做完手术', ['health']],
    ['我老婆不让我看直播', ['family']],
    ['我 妈​妈 说的', ['family']],
    ['电话１３８１２３４５６７８', ['contact']],
    ['邮箱 Someone@Example.COM', ['contact']],
    ['加我 V X: abc_12345', ['contact']],
    ['身份证号写错了', ['identity']],
    ['11010119900307123X', ['identity']],
    ['我今年17岁', ['identity']],
  ];
  for (const [text, categories] of cases) {
    assert.deepEqual(gateway.check(text), { ok: false, categories }, text);
  }
  for (const text of [
    '主播你好',
    '今天玩什么',
    '第3关有点难（真的）。',
    '你妈妈还好吗',
    '逆转裁判',
  ]) {
    assert.deepEqual(gateway.check(text), { ok: true }, text);
  }
  assert.equal(normalizeForRules(' Ａ​B c '), 'abc');
  assert.deepEqual(new PrivacyGateway([]).check('我住在上海'), { ok: true }, '空规则不过滤');
  assert.throws(() => new PrivacyGateway([{ category: 'x', pattern: '[' }]), /第 1 条/);
});
