import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readJsonFile, resolveProfile } from '@bellis/kernel';
import Value from 'typebox/value';
import { vtsAvatar } from '../src/index.ts';

const profile = (name: string) =>
  resolveProfile(
    readJsonFile(fileURLToPath(new URL(`../../../config/profiles/${name}`, import.meta.url))),
    [],
  );

test('live 样例 profile 启用形象并授予 secret:vts，配置符合清单；sim profile 不含形象', () => {
  const avatar = profile('live.example.json').find((entry) => entry.plugin === 'avatar-vts');
  assert.ok(avatar);
  assert.equal(avatar.disabled, false);
  assert.deepEqual(avatar.grant, ['secret:vts']);
  const schema = vtsAvatar.manifest.config;
  const config = Value.Default(schema, structuredClone(avatar.config));
  assert.ok(Value.Check(schema, config));
  assert.equal((config as { url: string }).url, 'ws://127.0.0.1:8001');
  assert.equal(
    profile('sim.json').some((entry) => entry.plugin === 'avatar-vts'),
    false,
  );
});

test('形象的地址只接受本机 127.0.0.1', () => {
  const schema = vtsAvatar.manifest.config;
  const check = (url: string) => Value.Check(schema, Value.Default(schema, { url }));
  assert.equal(check('ws://127.0.0.1:8001'), true);
  assert.equal(check('ws://192.168.1.2:8001'), false);
  assert.equal(check('ws://localhost:8001'), false);
  assert.equal(check('wss://127.0.0.1:8001'), false);
});
