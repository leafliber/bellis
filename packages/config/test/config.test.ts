import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MemorySecretStore } from '@bellis/secret-store';
import {
  loadConfig,
  OBS_SECRET,
  obsSecretName,
  readObsSecret,
  SIM_OBS_SECRET,
  writeObsSecret,
} from '../src/index.ts';

const simConfig = fileURLToPath(new URL('../../../config/sim.json', import.meta.url));

test('仓库自带的 sim 配置合法，存储路径相对配置文件解析', () => {
  const config = loadConfig(simConfig);
  assert.equal(config.simulation, true);
  assert.equal(config.storePath, resolve(simConfig, '../../.bellis/sim.db'));
});

test('真实配置样例合法：不是仿真，profile 指向不入库的真实 profile', () => {
  const config = loadConfig(
    fileURLToPath(new URL('../../../config/live.example.json', import.meta.url)),
  );
  assert.equal(config.simulation, false);
  assert.equal(obsSecretName(config), OBS_SECRET);
  assert.equal(config.profile, resolve(simConfig, '../profiles/live.json'));
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
  await assert.rejects(readObsSecret(store, OBS_SECRET), /没有 OBS 凭据/);
  await writeObsSecret(store, { url: 'ws://127.0.0.1:4455', password: 'p' }, OBS_SECRET);
  assert.deepEqual(await readObsSecret(store, OBS_SECRET), {
    url: 'ws://127.0.0.1:4455',
    password: 'p',
  });
  await assert.rejects(writeObsSecret(store, { url: 'http://x' }, OBS_SECRET), /不合法/);
});

test('模拟与真实 OBS 的凭据分开存放，跑仿真不碰真实凭据', async () => {
  assert.equal(obsSecretName({ simulation: true }), SIM_OBS_SECRET);
  assert.equal(obsSecretName({ simulation: false }), OBS_SECRET);
  assert.notEqual(SIM_OBS_SECRET, OBS_SECRET);
  const store = new MemorySecretStore();
  await writeObsSecret(store, { url: 'ws://127.0.0.1:4455', password: 'real' }, OBS_SECRET);
  await writeObsSecret(store, { url: 'ws://127.0.0.1:9' }, SIM_OBS_SECRET);
  await store.delete(SIM_OBS_SECRET);
  assert.deepEqual(await readObsSecret(store, OBS_SECRET), {
    url: 'ws://127.0.0.1:4455',
    password: 'real',
  });
});
