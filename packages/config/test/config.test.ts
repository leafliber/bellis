import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MemorySecretStore } from '@bellis/secret-store';
import { loadConfig, readObsSecret, writeObsSecret } from '../src/index.ts';

const simConfig = fileURLToPath(new URL('../../../config/sim.json', import.meta.url));

test('仓库自带的 sim 配置合法，存储路径相对配置文件解析', () => {
  const config = loadConfig(simConfig);
  assert.equal(config.simulation, true);
  assert.equal(config.storePath, resolve(simConfig, '../../.bellis/sim.db'));
});

test('不合法的配置报出位置', () => {
  const path = join(tmpdir(), `bellis-config-${randomBytes(4).toString('hex')}.json`);
  writeFileSync(path, JSON.stringify({ v: 1, storePath: 'x' }));
  try {
    assert.throws(() => loadConfig(path), /不合法/);
  } finally {
    rmSync(path, { force: true });
  }
});

test('OBS 凭据读写都校验格式', async () => {
  const store = new MemorySecretStore();
  await assert.rejects(readObsSecret(store), /没有 OBS 凭据/);
  await writeObsSecret(store, { url: 'ws://127.0.0.1:4455', password: 'p' });
  assert.deepEqual(await readObsSecret(store), { url: 'ws://127.0.0.1:4455', password: 'p' });
  await assert.rejects(writeObsSecret(store, { url: 'http://x' }), /不合法/);
});
