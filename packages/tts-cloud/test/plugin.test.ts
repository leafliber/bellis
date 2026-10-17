import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readJsonFile, resolveProfile } from '@bellis/kernel';
import {
  heardPrefix,
  SpeechService,
  type Synthesis,
  speakable,
  TtsService,
  type UtteranceOutcome,
} from '@bellis/speech';
import { type FromPage, StageService } from '@bellis/stage';
import Value from 'typebox/value';
import { CloudTtsConfig, cloudTts } from '../src/index.ts';
import { FakeMinimax } from './fake-minimax.ts';
import { FakeVolcengine } from './fake-volcengine.ts';
import { CLOUD_GRANT, entry, wait, world } from './helpers.ts';

const MINIMAX_KEY = 'mm-key-123456';
const VOLC_KEY = 'volc-key-123456';

async function fakes(options: { samplesPerChar?: number; chunkDelayMs?: number } = {}) {
  const minimax = await FakeMinimax.start({ apiKey: MINIMAX_KEY, ...options });
  const volcengine = await FakeVolcengine.start({ apiKey: VOLC_KEY, ...options });
  return {
    minimax,
    volcengine,
    config(overrides: Record<string, unknown> = {}) {
      return {
        primary: 'minimax',
        fallback: ['volcengine', 'subtitles'],
        retryAfterMs: 60_000,
        connectTimeoutMs: 1000,
        firstAudioTimeoutMs: 1000,
        minimax: {
          egress: true,
          endpoint: minimax.url,
          model: 'speech-2.8-turbo',
          voiceId: 'v',
          sampleRate: 8000,
        },
        volcengine: {
          egress: true,
          endpoint: volcengine.url,
          resourceId: 'seed-tts-1.0',
          speaker: 's',
          sampleRate: 8000,
          timestamps: 'timestamp',
        },
        ...overrides,
      };
    },
    async close() {
      await minimax.close();
      await volcengine.close();
    },
  };
}

async function drain(synthesis: Synthesis): Promise<number> {
  let samples = 0;
  for await (const frame of synthesis.frames) samples += frame.length;
  return samples;
}

const secrets = { minimax: MINIMAX_KEY, volcengine: VOLC_KEY };

test('外发未开启时不连接任何厂商，按 profile 只出字幕，切换记入事件', async () => {
  const f = await fakes();
  const config = f.config({
    minimax: { egress: false, endpoint: f.minimax.url, model: 'm', voiceId: 'v' },
    volcengine: { egress: false, endpoint: f.volcengine.url, speaker: 's' },
  });
  const w = await world([entry('tts', 'tts-cloud', { config, grant: CLOUD_GRANT })], secrets);
  try {
    assert.equal(w.state('tts')?.state, 'active');
    const tts = w.service(TtsService);
    const synthesis = await tts.synthesize('你好，世界。', new AbortController().signal);
    const samples = await drain(synthesis);
    // 只出字幕：静音帧按估计时长（220ms/字，句末标点 1.5 倍）铺开，映射完整。
    assert.equal(synthesis.sampleRate, 16_000);
    assert.equal(samples, Math.round(6.5 * 220 * 16));
    assert.equal(synthesis.totalSamples, samples);
    assert.equal(synthesis.timing?.length, 6);
    assert.equal(f.minimax.connections + f.volcengine.connections, 0);
    assert.equal(f.minimax.authorizations.length + f.volcengine.headers.length, 0);
    const switched = w.events('tts.switched').map((e) => e.data);
    assert.deepEqual(switched, [
      { from: 'minimax', to: 'subtitles', reason: 'minimax 外发未开启' },
    ]);
    assert.ok(
      w.logs.some((l) => l.event === 'tts.engine-unavailable' && l.fields.engine === 'volcengine'),
    );
  } finally {
    await w.close();
    await f.close();
  }
});

test('没有任何可用的引擎时插件停在 FAILED，并说明原因', async () => {
  const f = await fakes();
  const config = f.config({ fallback: [], minimax: { egress: false } });
  const w = await world([entry('tts', 'tts-cloud', { config, grant: CLOUD_GRANT })], secrets);
  try {
    const state = w.state('tts');
    assert.equal(state?.state, 'failed');
    assert.match(state?.reason ?? '', /没有可用的 TTS 引擎：minimax 外发未开启/);
  } finally {
    await w.close();
    await f.close();
  }
});

test('外发主机与凭据权限：清单申请的未授予时停在 WAITING；端点主机未授予时不连接', async () => {
  const f = await fakes();
  const w = await world(
    [
      entry('tts', 'tts-cloud', {
        config: f.config(),
        grant: CLOUD_GRANT.filter((p) => p !== 'secret:volcengine'),
      }),
      entry('tts2', 'tts-cloud', {
        config: f.config({ fallback: ['subtitles'] }),
        grant: CLOUD_GRANT.filter((p) => p !== 'net.egress:127.0.0.1'),
        disabled: true,
      }),
    ],
    secrets,
  );
  try {
    assert.equal(w.state('tts')?.state, 'waiting');
    assert.match(w.state('tts')?.reason ?? '', /未授予权限 secret:volcengine/);
    await w.kernel.disable('tts');
    await w.kernel.enable('tts2');
    assert.equal(w.state('tts2')?.state, 'active');
    const synthesis = await w
      .service(TtsService)
      .synthesize('你好。', new AbortController().signal);
    await drain(synthesis);
    assert.equal(f.minimax.connections, 0);
    assert.match(
      String((w.events('tts.switched')[0]?.data as { reason?: string } | undefined)?.reason),
      /未授予权限 net\.egress:127\.0\.0\.1/,
    );
  } finally {
    await w.close();
    await f.close();
  }
});

test('主引擎鉴权失败时切到备用并记入事件；冷却期满后恢复主引擎', async () => {
  const f = await fakes();
  const w = await world(
    [entry('tts', 'tts-cloud', { config: f.config({ retryAfterMs: 300 }), grant: CLOUD_GRANT })],
    { minimax: 'wrong-key-000', volcengine: VOLC_KEY },
  );
  try {
    const tts = w.service(TtsService);
    const first = await tts.synthesize('你好。', new AbortController().signal);
    assert.equal(await drain(first), 3 * 80);
    assert.equal(f.volcengine.connections, 1);
    // 冷却期内不再尝试主引擎。
    await drain(await tts.synthesize('再见。', new AbortController().signal));
    assert.equal(f.minimax.authorizations.length, 1);
    await w.secrets.set('minimax', MINIMAX_KEY);
    await wait(350);
    await drain(await tts.synthesize('回来了。', new AbortController().signal));
    assert.equal(f.minimax.events('task_continue').length, 1);
    const switched = w.events('tts.switched').map((e) => e.data as Record<string, unknown>);
    assert.equal(switched.length, 2);
    assert.equal(switched[0]?.from, 'minimax');
    assert.equal(switched[0]?.to, 'volcengine');
    assert.match(String(switched[0]?.reason), /minimax 鉴权失败/);
    assert.deepEqual(switched[1], {
      from: 'volcengine',
      to: 'minimax',
      reason: 'minimax 恢复可用',
    });
    // 凭据的值不进事件与日志。
    const text = JSON.stringify([w.store.events(), w.logs]);
    assert.ok(!text.includes('wrong-key-000') && !text.includes(MINIMAX_KEY));
    assert.ok(
      w.logs.some((l) => l.event === 'tts.switched' && String(l.fields.hint).includes('音色')),
    );
  } finally {
    await w.close();
    await f.close();
  }
});

test('两家都不可用时按 profile 只出字幕；没有备选时合成以错误结束', async () => {
  const f = await fakes();
  const broken = { minimax: 'bad-key-1', volcengine: 'bad-key-2' };
  const w = await world(
    [
      entry('tts', 'tts-cloud', { config: f.config(), grant: CLOUD_GRANT }),
      entry('tts2', 'tts-cloud', {
        config: f.config({ fallback: [] }),
        grant: CLOUD_GRANT,
        disabled: true,
      }),
    ],
    broken,
  );
  try {
    const synthesis = await w
      .service(TtsService)
      .synthesize('你好。', new AbortController().signal);
    await drain(synthesis);
    assert.equal(synthesis.sampleRate, 16_000);
    assert.deepEqual(
      w.events('tts.switched').map((e) => (e.data as { to: string }).to),
      ['subtitles'],
    );
    await w.kernel.disable('tts');
    await w.kernel.enable('tts2');
    await assert.rejects(
      w.service(TtsService).synthesize('你好。', new AbortController().signal),
      /没有可用的 TTS 引擎：minimax 鉴权失败/,
    );
  } finally {
    await w.close();
    await f.close();
  }
});

test('两段式对齐：句段一到即有插值映射，随音频到达的时间戳细化，完成后有实际总采样数', async () => {
  const f = await fakes({ chunkDelayMs: 20 });
  const w = await world(
    [entry('tts', 'tts-cloud', { config: f.config({ msPerChar: 100 }), grant: CLOUD_GRANT })],
    secrets,
  );
  try {
    const synthesis = await w
      .service(TtsService)
      .synthesize('你好呀朋友', new AbortController().signal);
    // 插值：每字 100ms，8kHz 下 800 个采样。
    assert.deepEqual(
      synthesis.timing?.map((t) => t.sample),
      [0, 800, 1600, 2400, 3200],
    );
    assert.equal(synthesis.totalSamples, undefined);
    const samples = await drain(synthesis);
    assert.equal(samples, 5 * 80);
    assert.deepEqual(
      synthesis.timing?.map((t) => t.sample),
      [0, 80, 160, 240, 320],
    );
    assert.equal(synthesis.totalSamples, 400);
  } finally {
    await w.close();
    await f.close();
  }
});

test('发声链路：急停截断后写回与 Stage 回报的已播采样数逐字一致，并向厂商取消', async () => {
  // 每字 50ms 的音频，按实时播放；合成得比播放稍慢，急停时合成还在进行。
  const f = await fakes({ samplesPerChar: 400, chunkDelayMs: 120 });
  const w = await world(
    [
      entry('stage-page', 'stage-page-sim'),
      entry('stage', 'stage-service'),
      entry('tts', 'tts-cloud', { config: f.config(), grant: CLOUD_GRANT }),
      entry('speech', 'speech-arbiter', { grant: ['speech.output'] }),
    ],
    secrets,
  );
  try {
    assert.deepEqual(w.safety.requestMode('M0'), { ok: true });
    const truncated: FromPage[] = [];
    let cursor = 0;
    w.service(StageService).onEvent((event) => {
      if (event.kind === 'truncated') truncated.push(event);
      if (event.kind === 'cursor') cursor = event.played;
    });
    const text = '今天我们一起玩魔女审判，好不好呀';
    const outcome: Promise<UtteranceOutcome> = w.service(SpeechService).request({
      id: 'u1',
      source: 'chatter',
      text,
      expiresAt: Number.POSITIVE_INFINITY,
      preempt: 'sentence',
      inputs: [],
      untrusted: false,
    });
    // 播出约四个字后急停（此时合成还没结束）。
    for (let waited = 0; cursor < 1700 && waited < 10_000; waited += 10) await wait(10);
    await w.safety.emergencyStop('测试急停');
    const result = await outcome;
    assert.equal(result.end, 'stopped');
    const played = (truncated[0] as { played: number } | undefined)?.played ?? 0;
    assert.ok(played > 0, '急停前应已播出一部分');
    // 按假服务器的精确时间（每字 400 个采样）独立推出观众听到的前缀。
    const subtitle = '今天我们一起玩魔女审判，';
    const chars = Math.floor(played / 400);
    const { align } = speakable(subtitle);
    const expected =
      chars > 0 ? [...subtitle].slice(0, (align[chars - 1] as number) + 1).join('') : '';
    assert.equal(result.heard, expected);
    assert.equal(
      heardPrefix(
        { index: 0, subtitle, spoken: subtitle, align },
        played,
        [...subtitle].map((_, i) => ({ sample: i * 400, char: i })),
        undefined,
      ),
      expected,
    );
    await wait(100);
    assert.equal(f.minimax.events('task_cancel').length, 1);
  } finally {
    await w.close();
    await f.close();
  }
});

test('发声链路：没有可用的 TTS 引擎时这一句以“不可用”结束，不播出', async () => {
  const f = await fakes();
  const w = await world(
    [
      entry('stage-page', 'stage-page-sim'),
      entry('stage', 'stage-service'),
      entry('tts', 'tts-cloud', { config: f.config({ fallback: [] }), grant: CLOUD_GRANT }),
      entry('speech', 'speech-arbiter', { grant: ['speech.output'] }),
    ],
    { minimax: 'bad-key-1' },
  );
  try {
    assert.deepEqual(w.safety.requestMode('M0'), { ok: true });
    const result = await w.service(SpeechService).request({
      id: 'u1',
      source: 'chatter',
      text: '你好。',
      expiresAt: Number.POSITIVE_INFINITY,
      preempt: 'sentence',
      inputs: [],
      untrusted: false,
    });
    assert.equal(result.end, 'unavailable');
    assert.match(result.reason ?? '', /TTS 不可用：没有可用的 TTS 引擎/);
    assert.equal(result.heard, '');
  } finally {
    await w.close();
    await f.close();
  }
});

test('示例 profile 中的云端 TTS 条目默认禁用、两家都不外发，配置符合 Schema，授予清单申请的权限', () => {
  const path = fileURLToPath(
    new URL('../../../config/profiles/live.example.json', import.meta.url),
  );
  const found = resolveProfile(readJsonFile(path)).find((e) => e.plugin === 'tts-cloud');
  assert.ok(found);
  assert.equal(found.disabled, true);
  const config = Value.Default(CloudTtsConfig, structuredClone(found.config));
  assert.ok(Value.Check(CloudTtsConfig, config));
  const checked = config as CloudTtsConfig;
  assert.equal(checked.minimax.egress, false);
  assert.equal(checked.volcengine.egress, false);
  assert.deepEqual([...found.grant].sort(), [...cloudTts.manifest.permissions].sort());
});
