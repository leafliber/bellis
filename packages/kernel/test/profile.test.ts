import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatEntries, resolveProfile } from '../src/index.ts';

const profile = {
  name: 'sim',
  packs: [
    {
      name: 'core',
      entries: [
        { id: 'clock', plugin: 'clock-sim' },
        { id: 'tts', plugin: 'tts-sim', config: { voice: 'a' } },
      ],
    },
    { name: 'speech', entries: [{ id: 'moderation', plugin: 'moderation-sim', disabled: false }] },
  ],
};

test('记录启用或禁用是否显式写明', () => {
  const entries = resolveProfile(profile, [{ name: 'p', ops: [{ op: 'disable', id: 'clock' }] }]);
  assert.deepEqual(
    entries.map((e) => [e.id, e.explicitSwitch]),
    [
      ['clock', true],
      ['tts', false],
      ['moderation', true],
    ],
  );
});

test('按包的顺序展开', () => {
  assert.deepEqual(
    resolveProfile(profile).map((e) => e.id),
    ['clock', 'tts', 'moderation'],
  );
});

test('patch 可以替换、插入、禁用与启用条目', () => {
  const entries = resolveProfile(profile, [
    {
      name: 'local',
      ops: [
        { op: 'replace', entry: { id: 'tts', plugin: 'tts-other', config: { voice: 'b' } } },
        { op: 'insert', entry: { id: 'avatar', plugin: 'avatar-sim' }, after: 'clock' },
        { op: 'disable', id: 'moderation' },
      ],
    },
    {
      name: 'later',
      ops: [
        { op: 'enable', id: 'moderation' },
        { op: 'disable', id: 'clock' },
      ],
    },
  ]);
  assert.deepEqual(
    entries.map((e) => [e.id, e.plugin, e.disabled]),
    [
      ['clock', 'clock-sim', true],
      ['avatar', 'avatar-sim', false],
      ['tts', 'tts-other', false],
      ['moderation', 'moderation-sim', false],
    ],
  );
  assert.deepEqual(entries[2]?.config, { voice: 'b' });
  assert.match(formatEntries(entries), /tts ← tts-other（启用）/);
});

test('安全核不是插件：profile 与 patch 都不能提到它', () => {
  const withSafety = {
    name: 'bad',
    packs: [{ name: 'p', entries: [{ id: 'safety', plugin: 'safety-core' }] }],
  };
  assert.throws(() => resolveProfile(withSafety), /安全核不是插件/);
  for (const op of [
    { op: 'disable', id: 'safety' },
    { op: 'replace', entry: { id: 'safety.gate', plugin: 'x' } },
    { op: 'insert', entry: { id: 'gate', plugin: 'safety-core' } },
  ]) {
    assert.throws(() => resolveProfile(profile, [{ name: 'evil', ops: [op] }]), /安全核不是插件/);
  }
});

test('引用不存在的条目、重复条目、格式错误都报错', () => {
  assert.throws(
    () => resolveProfile(profile, [{ name: 'p', ops: [{ op: 'disable', id: 'nope' }] }]),
    /没有条目 nope/,
  );
  assert.throws(
    () =>
      resolveProfile(profile, [
        { name: 'p', ops: [{ op: 'insert', entry: { id: 'tts', plugin: 'x' } }] },
      ]),
    /已存在/,
  );
  assert.throws(
    () =>
      resolveProfile({
        name: 'dup',
        packs: [
          {
            name: 'a',
            entries: [
              { id: 'x', plugin: 'x' },
              { id: 'x', plugin: 'y' },
            ],
          },
        ],
      }),
    /重复/,
  );
  assert.throws(() => resolveProfile({ name: 'Bad Name', packs: [] }), /profile 不合法/);
});
