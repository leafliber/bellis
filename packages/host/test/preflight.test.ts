import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EntrySnapshot } from '@bellis/kernel';
import { type PreflightInputs, preflight } from '../src/preflight.ts';

const plugin = (id: string, state: EntrySnapshot['state'], enabled = true): EntrySnapshot => ({
  id,
  plugin: id,
  version: '0.1.0',
  tier: 'ordinary',
  process: 'in-process',
  state,
  reason: state === 'active' ? undefined : '缺少服务 tts@1',
  instanceId: undefined,
  enabled,
});

const ready: PreflightInputs = {
  target: 'M1',
  plugins: [plugin('stage', 'active'), plugin('moderation', 'waiting', false)],
  stageReady: true,
  avatar: { ready: true, status: '就绪' },
  moderationEnabled: false,
  reviewPresent: true,
  inspectObs: async () => [],
};

test('开播预检：全部就绪时没有未通过项', async () => {
  assert.deepEqual(await preflight(ready), []);
});

test('开播预检：形象在场但未就绪时列出状态；profile 不含形象时不作要求', async () => {
  assert.deepEqual(
    await preflight({
      ...ready,
      avatar: { ready: false, status: '参数 MouthOpen 已被其他插件占用' },
    }),
    ['形象未就绪（参数 MouthOpen 已被其他插件占用）'],
  );
  assert.deepEqual(await preflight({ ...ready, avatar: undefined }), []);
});

test('开播预检：插件未就绪、Stage 未认证、审核开关未设置、M1 缺放行环节、OBS 目标不对都列出', async () => {
  const failures = await preflight({
    ...ready,
    plugins: [plugin('tts', 'waiting'), plugin('off', 'waiting', false)],
    stageReady: false,
    moderationEnabled: undefined,
    reviewPresent: false,
    inspectObs: async () => ['OBS 中没有安全场景「Safe」'],
  });
  assert.deepEqual(failures, [
    '插件 tts 未就绪（waiting：缺少服务 tts@1）',
    'Stage 页面尚未认证',
    '审核插件的开关没有在 profile 中显式设置',
    'M1 需要逐句放行环节（speech-review）',
    'OBS 中没有安全场景「Safe」',
  ]);
});

test('开播预检：M2 不要求放行环节；没有 Stage 服务或 OBS 核对出错都算未通过', async () => {
  const failures = await preflight({
    ...ready,
    target: 'M2',
    reviewPresent: false,
    stageReady: undefined,
    inspectObs: async () => {
      throw new Error('连接已关闭');
    },
  });
  assert.deepEqual(failures, ['Stage 服务不在场', 'OBS 预检失败：连接已关闭']);
});
