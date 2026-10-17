import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectObsTargets, ObsClient, runEmergency, SimObs } from '../src/index.ts';

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

test('批量结果缺失或对不上时，应急结果为失败', async () => {
  const fake = {
    batch: async () => [{ requestType: 'SetInputMute', ok: true, code: 100 }],
  } as unknown as Parameters<typeof runEmergency>[0];
  assert.equal((await runEmergency(fake, policy)).ok, false);
  const empty = { batch: async () => [] } as unknown as Parameters<typeof runEmergency>[0];
  assert.equal((await runEmergency(empty, policy)).ok, false);
});

test('开播预检核对应急目标：安全场景与 Stage 源存在、浏览器源设置正确、安全场景不含 Stage 源', async () => {
  const policy = { stageSource: 'Stage', safeScene: 'Safe', stopStream: false };
  const good = await SimObs.start({ inputSettings: { Stage: { reroute_audio: true } } });
  const bad = await SimObs.start({
    scenes: ['Live', 'Safe'],
    inputSettings: { Stage: { shutdown: true, restart_when_active: true } },
    sceneItems: { Live: ['Stage'], Safe: ['Stage'] },
  });
  const missing = await SimObs.start({ scenes: ['Live'], inputs: ['Other'] });
  const clients = await Promise.all(
    [good, bad, missing].map((obs) => ObsClient.connect(obs.url, undefined)),
  );
  try {
    const [ok, wrong, absent] = await Promise.all(
      clients.map((client) => inspectObsTargets(client, policy)),
    );
    assert.deepEqual(ok, []);
    assert.equal(wrong?.length, 4);
    assert.ok(wrong?.some((f) => f.includes('Control audio via OBS')));
    assert.ok(wrong?.some((f) => f.includes('安全场景「Safe」里含有')));
    assert.deepEqual(absent, ['OBS 中没有安全场景「Safe」', 'OBS 中没有 Stage 源「Stage」']);
  } finally {
    for (const client of clients) client.close();
    await Promise.all([good, bad, missing].map((obs) => obs.close()));
  }
});
