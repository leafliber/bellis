import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { director } from '@bellis/director';
import { readJsonFile, resolveProfile } from '@bellis/kernel';
import Value from 'typebox/value';
import { ARK_CHAT_ENDPOINT, configBlocker, LlmOpenAiConfig, llmOpenAi } from '../src/index.ts';

test('示例 profile：模型客户端与决策插件默认禁用；客户端只授予清单申请的权限，决策插件不授予任何权限', () => {
  const path = fileURLToPath(
    new URL('../../../config/profiles/live.example.json', import.meta.url),
  );
  const entries = resolveProfile(readJsonFile(path), []);
  const client = entries.find((e) => e.plugin === 'llm-openai');
  assert.ok(client);
  assert.equal(client.disabled, true);
  assert.deepEqual([...client.grant].sort(), [...llmOpenAi.manifest.permissions].sort());
  const config = Value.Default(LlmOpenAiConfig, structuredClone(client.config));
  assert.ok(
    Value.Check(LlmOpenAiConfig, config),
    JSON.stringify([...Value.Errors(LlmOpenAiConfig, config)]),
  );
  const typed = config as LlmOpenAiConfig;
  assert.equal(typed.endpoint, ARK_CHAT_ENDPOINT);
  assert.equal(typed.model, 'glm-5-3-flash-260828');
  assert.equal(typed.reasoningEffort, 'low');
  // 开播预检的探测会外发、会计费：样例显式写明不发。
  assert.equal((client.config as { probeOnPreflight?: boolean }).probeOnPreflight, false);
  // 型号不是机密；配置齐全，只差凭据。
  assert.equal(configBlocker(typed, new Set(client.grant)), undefined);

  const decider = entries.find((e) => e.plugin === 'director');
  assert.ok(decider);
  // 决策插件解读观众输入：不授予任何凭据与权限（Rule of Two），随弹幕接入与分诊一起启用。
  assert.deepEqual(decider.grant, []);
  assert.equal(decider.disabled, true);
  assert.ok(
    Value.Check(
      director.manifest.config,
      Value.Default(director.manifest.config, structuredClone(decider.config)),
    ),
  );
  const triage = entries.find((e) => e.plugin === 'audience-triage');
  assert.equal(triage?.disabled, decider.disabled);
});
