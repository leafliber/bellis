import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySecretStore } from '@bellis/secret-store';
import { pluginSecrets } from '../src/secrets.ts';

test('插件凭据：只能读写授予的条目；宿主管理的条目授予了也拿不到', async () => {
  const store = new MemorySecretStore();
  await store.set('vts', 'token-1');
  await store.set('obs', '{"url":"ws://x"}');
  const secrets = pluginSecrets(
    store,
    new Set(['secret:vts', 'secret:obs']),
    new Set(['obs', 'session']),
  );
  assert.equal(await secrets.read('vts'), 'token-1');
  await secrets.write('vts', 'token-2');
  assert.equal(await store.get('vts'), 'token-2');
  await assert.rejects(secrets.read('obs'), /由宿主管理/);
  await assert.rejects(secrets.read('minimax'), /没有权限 secret:minimax/);
  await assert.rejects(secrets.write('minimax', 'x'), /没有权限/);
  assert.equal(await secrets.delete('vts'), true);
  assert.equal(await secrets.read('vts'), undefined);
});
