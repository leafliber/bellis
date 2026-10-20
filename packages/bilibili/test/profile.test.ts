import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readJsonFile, resolveProfile } from '@bellis/kernel';
import Value from 'typebox/value';
import { BilibiliConfig, configBlocker, danmakuBilibili } from '../src/index.ts';

test('示例 profile：弹幕接入默认禁用、项目 ID 是占位值，配置符合 Schema，授予清单申请的权限；分诊也在', () => {
  const path = fileURLToPath(
    new URL('../../../config/profiles/live.example.json', import.meta.url),
  );
  const entries = resolveProfile(readJsonFile(path), []);
  const found = entries.find((e) => e.plugin === 'danmaku-bilibili');
  assert.ok(found);
  assert.equal(found.disabled, true);
  const config = Value.Default(BilibiliConfig, structuredClone(found.config));
  assert.ok(Value.Check(BilibiliConfig, config));
  assert.deepEqual([...found.grant].sort(), [...danmakuBilibili.manifest.permissions].sort());
  // 占位的项目 ID 让插件停在“未配置”，不会拿示例去连平台。
  assert.equal(
    configBlocker(config as BilibiliConfig, new Set(found.grant)),
    '未配置项目 ID（appId）',
  );
  const triage = entries.find((e) => e.plugin === 'audience-triage');
  assert.ok(triage);
  // 分诊没有凭据与权限（Rule of Two），随接入一起启用。
  assert.deepEqual(triage.grant, []);
  assert.equal(triage.disabled, found.disabled);
});
