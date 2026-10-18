import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INPUT_VOLUME_METERS,
  inspectObsTargets,
  type MeterLevel,
  ObsClient,
  ObsMeters,
  runEmergency,
  SimObs,
} from '../src/index.ts';

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

test('开播预检核对急停后的状态：节目场景是安全场景、Stage 源被静音都不通过', async () => {
  const policy = { stageSource: 'Stage', safeScene: 'Safe', stopStream: false };
  const obs = await SimObs.start({ inputSettings: { Stage: { reroute_audio: true } } });
  const client = await ObsClient.connect(obs.url, undefined);
  try {
    // 急停：切到安全场景并静音 Stage 源。
    assert.equal((await runEmergency(client, policy)).ok, true);
    assert.deepEqual(await inspectObsTargets(client, policy), [
      '节目场景是安全场景「Safe」，先切回直播场景',
      'Stage 源「Stage」被静音，先取消静音',
    ]);
    // 操作员只切回场景：仍因静音不通过。
    await client.request('SetCurrentProgramScene', { sceneName: 'Live' });
    assert.deepEqual(await inspectObsTargets(client, policy), [
      'Stage 源「Stage」被静音，先取消静音',
    ]);
    await client.request('SetInputMute', { inputName: 'Stage', inputMuted: false });
    assert.deepEqual(await inspectObsTargets(client, policy), []);
  } finally {
    client.close();
    await obs.close();
  }
});

test('只读音量表连接：只订阅 InputVolumeMeters，读推子前的峰值，只发同步偏移的读请求', async () => {
  const obs = await SimObs.start({ password: 'secret' });
  obs.syncOffsets.set('Stage', -20);
  const meters = await ObsMeters.connect(obs.url, 'secret');
  try {
    assert.deepEqual(obs.subscriptions, [INPUT_VOLUME_METERS]);
    const seen: MeterLevel[][] = [];
    meters.onLevels((levels) => seen.push(levels));
    obs.emitMeters([
      // 两个声道的 [magnitude, peak, inputPeak]：取推子前（inputPeak）的最大值。
      {
        inputName: 'Stage',
        levels: [
          [0.01, 0.05, 0.1],
          [0.02, 0.04, 0.2],
        ],
      },
      { inputName: 'Mic', levels: [[0, 0, 0]] },
    ]);
    while (seen.length === 0) await new Promise((done) => setTimeout(done, 5));
    const [stage, mic] = seen[0] ?? [];
    assert.equal(stage?.inputName, 'Stage');
    assert.ok(Math.abs((stage?.peakDb ?? 0) - 20 * Math.log10(0.2)) < 1e-9);
    assert.equal(mic?.peakDb, -Infinity);
    assert.equal(await meters.audioSyncOffset('Stage'), -20);
    assert.equal(await meters.audioSyncOffset('Nope'), null);
    // 除了读同步偏移，没有任何请求（更没有控制请求）。
    assert.deepEqual(
      [...new Set(obs.requests.map((r) => r.requestType))],
      ['GetInputAudioSyncOffset'],
    );
  } finally {
    meters.close();
    await obs.close();
  }
});
