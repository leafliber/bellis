/**
 * 仓库自带的真实 profile 样例：按宿主实际装配的核心服务与内置插件的清单，核对每个条目的授权与依赖关系。
 * 互动包（interaction）缺省整体禁用，由 `config/patches/interaction.json` 整体启用（见运维“真实配置的样例”）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '@bellis/config';
import {
  ClockService,
  DataDirService,
  RandomService,
  type ResolvedEntry,
  readJsonFile,
  resolveProfile,
  SecretsService,
  SidecarHostService,
} from '@bellis/kernel';
import { builtinPlugins } from '@bellis/plugins';
import { SafetyService } from '@bellis/safety';
import { ObsConnectorService, ObsMetersService } from '@bellis/stage';

const path = (relative: string) =>
  fileURLToPath(new URL(`../../../config/${relative}`, import.meta.url));

/** 宿主（main.ts）在加载插件之前提供的核心服务。 */
const HOST_CORE = new Set(
  [
    SidecarHostService,
    ClockService,
    RandomService,
    DataDirService,
    SafetyService,
    SecretsService,
    ObsConnectorService,
    ObsMetersService,
  ].map((service) => service.ref),
);

/** P2 的互动包：弹幕接入、分诊、投票、模型客户端、决策，整体启用或禁用。 */
const INTERACTION = ['danmaku', 'triage', 'vote', 'llm', 'director'];

const profile = () => readJsonFile(path('profiles/live.example.json'));
const patch = () => readJsonFile(path('patches/interaction.json'));

function manifest(entry: ResolvedEntry) {
  const definition = builtinPlugins.get(entry.plugin);
  assert.ok(definition, `条目 ${entry.id} 引用了未知插件 ${entry.plugin}`);
  return definition.manifest;
}

/**
 * 每个条目只授予清单申请的权限（少了停在 WAITING，多了是多给）；每个启用条目的必需依赖都由核心服务
 * 或另一个启用的条目提供。
 */
function assertConsistent(entries: readonly ResolvedEntry[]): void {
  const provided = new Set(HOST_CORE);
  for (const entry of entries.filter((e) => !e.disabled)) {
    for (const ref of manifest(entry).provides) provided.add(ref);
  }
  for (const entry of entries) {
    assert.deepEqual(
      [...entry.grant].sort(),
      [...manifest(entry).permissions].sort(),
      `条目 ${entry.id} 的授权与清单不一致`,
    );
    if (entry.disabled) continue;
    for (const ref of manifest(entry).inject.filter((r) => !r.endsWith('?'))) {
      assert.ok(provided.has(ref), `启用的条目 ${entry.id} 依赖 ${ref}，没有启用的条目提供它`);
    }
  }
}

test('live 样例：媒体部分启用，互动包整体禁用，审核插件显式关闭；授权与依赖一致', () => {
  const entries = resolveProfile(profile(), []);
  assertConsistent(entries);
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const id of INTERACTION) {
    assert.equal(byId.get(id)?.disabled, true, `${id} 随互动包禁用`);
    assert.equal(byId.get(id)?.explicitSwitch, true, `${id} 的开关显式写明`);
  }
  // 互动包恰好是一个插件包，便于从样例整段复制。
  const packs = (profile() as { packs: Array<{ name: string; entries: Array<{ id: string }> }> })
    .packs;
  assert.deepEqual(
    packs.find((p) => p.name === 'interaction')?.entries.map((e) => e.id),
    INTERACTION,
  );
  const moderation = byId.get('moderation');
  assert.equal(moderation?.disabled, true);
  assert.equal(moderation?.explicitSwitch, true);
  for (const id of ['telemetry', 'speech', 'review', 'tts', 'tts-local', 'stage', 'avatar']) {
    assert.equal(byId.get(id)?.disabled, false, `${id} 启用`);
  }
});

test('live 样例加上 interaction patch：互动包整体启用，其余不变；授权与依赖一致', () => {
  const base = resolveProfile(profile(), []);
  const entries = resolveProfile(profile(), [patch()]);
  assertConsistent(entries);
  assert.deepEqual(
    (patch() as { ops: Array<{ op: string; id: string }> }).ops,
    INTERACTION.map((id) => ({ op: 'enable', id })),
    'patch 只启用互动包的条目',
  );
  for (const entry of entries) {
    const before = base.find((e) => e.id === entry.id);
    assert.equal(entry.disabled, INTERACTION.includes(entry.id) ? false : before?.disabled);
  }
  // 互动包里的先后关系（运维文档的升级对照据此写）。
  const byId = new Map(entries.map((e) => [e.id, manifest(e)]));
  const requires = (id: string) => byId.get(id)?.inject.filter((r) => !r.endsWith('?')) ?? [];
  const provides = (id: string) => byId.get(id)?.provides ?? [];
  const [danmaku] = provides('danmaku');
  const [candidates] = provides('triage');
  const [llm] = provides('llm');
  const [speech] = provides('speech');
  assert.ok(danmaku && candidates && llm && speech);
  assert.ok(requires('triage').includes(danmaku), '分诊依赖弹幕接入');
  assert.ok(requires('vote').includes(danmaku) && requires('vote').includes(speech));
  for (const ref of [candidates, llm, speech]) assert.ok(requires('director').includes(ref));
  assert.ok(
    byId.get('director')?.inject.includes(`${provides('vote')[0]}?`),
    '投票是决策插件的可选依赖',
  );
  // 只有接入插件持凭据；分诊、投票、决策不持凭据（Rule of Two）。
  for (const id of ['triage', 'vote', 'director']) {
    assert.ok(!byId.get(id)?.permissions.some((p) => p.startsWith('secret:')), id);
  }
});

test('live 配置样例不带 patch；interaction patch 相对配置文件所在目录引用', () => {
  const config = loadConfig(path('live.example.json'));
  assert.deepEqual(config.patches, []);
  // 维护者在 live.json 的 patches 里写 "patches/interaction.json"，按配置文件所在目录解析。
  assert.ok(readJsonFile(path('patches/interaction.json')));
});
