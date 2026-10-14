import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObsClient, runEmergency, SimObs } from '../src/index.ts';

const policy = { stageSource: 'Stage', safeScene: 'Safe', stopStream: true };

test('认证后可以发请求与批量请求', async () => {
  const obs = await SimObs.start({ password: 'secret' });
  const client = await ObsClient.connect(obs.url, 'secret');
  try {
    const scene = await client.request('GetCurrentProgramScene');
    assert.equal(scene.ok, true);
    assert.equal(scene.data?.currentProgramSceneName, 'Live');
    const missing = await client.request('SetCurrentProgramScene', { sceneName: 'Nope' });
    assert.deepEqual([missing.ok, missing.code], [false, 600]);
  } finally {
    client.close();
    await obs.close();
  }
});

test('密码错误或缺失时连接失败', async () => {
  const obs = await SimObs.start({ password: 'secret' });
  try {
    await assert.rejects(ObsClient.connect(obs.url, 'wrong'), /认证失败/);
    await assert.rejects(ObsClient.connect(obs.url, undefined), /没有提供密码/);
  } finally {
    await obs.close();
  }
});

test('应急批处理：静音 Stage、切安全场景、停推流', async () => {
  const obs = await SimObs.start();
  obs.streaming = true;
  const client = await ObsClient.connect(obs.url, undefined);
  try {
    const outcome = await runEmergency(client, policy);
    assert.equal(outcome.ok, true);
    assert.equal(obs.muted.get('Stage'), true);
    assert.equal(obs.currentScene, 'Safe');
    assert.equal(obs.streaming, false);
    // 推流本就没在运行时，停推流视为成功。
    assert.equal((await runEmergency(client, policy)).ok, true);
  } finally {
    client.close();
    await obs.close();
  }
});

test('OBS 出错时应急结果为失败', async () => {
  const obs = await SimObs.start();
  const client = await ObsClient.connect(obs.url, undefined);
  try {
    obs.failing = true;
    const outcome = await runEmergency(client, policy);
    assert.equal(outcome.ok, false);
  } finally {
    client.close();
    await obs.close();
  }
});

test('连接断开时未完成的请求失败，客户端得到关闭通知', async () => {
  const obs = await SimObs.start();
  const client = await ObsClient.connect(obs.url, undefined);
  const closed = new Promise<string>((resolve) => client.onClose(resolve));
  obs.disconnectAll();
  await closed;
  assert.equal(client.connected, false);
  await assert.rejects(client.request('GetStreamStatus'), /已关闭/);
  await obs.close();
});
