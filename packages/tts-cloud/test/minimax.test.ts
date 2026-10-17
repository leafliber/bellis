import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EngineError,
  MinimaxEngine,
  type MinimaxOptions,
  RequestError,
  type WireEvent,
} from '../src/index.ts';
import { FakeMinimax, type FakeMinimaxOptions, sampleValue } from './fake-minimax.ts';
import { collect, env, timeouts, wait } from './helpers.ts';

const KEY = 'test-key-minimax';

async function setup(
  fakeOptions: Partial<FakeMinimaxOptions> = {},
  options: Partial<MinimaxOptions> = {},
  secret: string | null = KEY,
) {
  const fake = await FakeMinimax.start({ apiKey: KEY, ...fakeOptions });
  const wire: WireEvent[] = [];
  const engine = new MinimaxEngine(
    {
      endpoint: fake.url,
      model: 'speech-2.8-turbo',
      voiceId: 'voice-1',
      sampleRate: 8000,
      speed: 1,
      vol: 1,
      pitch: 0,
      emotion: '',
      languageBoost: 'Chinese',
      subtitleType: 'word_streaming',
      pingIntervalMs: 30_000,
      ...options,
    },
    timeouts,
    env(secret ?? undefined, wire),
  );
  return {
    fake,
    engine,
    wire,
    async close() {
      engine.close();
      await fake.close();
    },
  };
}

test('MiniMax：鉴权头、task_start 参数，增量出音频，时间戳按字对上', async () => {
  const t = await setup({ chunkDelayMs: 20 });
  try {
    const stream = await t.engine.start('你好，世界。', new AbortController().signal);
    // 收到第一段音频就返回，不等整句合成完。
    assert.ok(t.fake.events('task_flush').length === 1);
    assert.ok(t.wire.filter((w) => w.kind === 'audio').length < 3);
    assert.equal(stream.sampleRate, 8000);
    const { pcm, words, audioChunks } = await collect(stream);
    assert.equal(t.fake.authorizations[0], `Bearer ${KEY}`);
    const start = t.fake.taskStarts[0] as Record<string, unknown>;
    assert.equal(start.model, 'speech-2.8-turbo');
    assert.deepEqual(start.audio_setting, { sample_rate: 8000, format: 'pcm', channel: 1 });
    assert.equal(start.subtitle_enable, true);
    assert.equal(start.subtitle_type, 'word_streaming');
    assert.equal(start.language_boost, 'Chinese');
    assert.equal(audioChunks, 3);
    assert.equal(pcm.length, 6 * 80);
    for (let char = 0; char < 6; char += 1) assert.equal(pcm[char * 80 + 7], sampleValue(char));
    assert.deepEqual(
      words.map((w) => [w.text, w.startMs, w.endMs]),
      [...'你好，世界。'].map((c, i) => [c, i * 10, (i + 1) * 10]),
    );
  } finally {
    await t.close();
  }
});

test('MiniMax：多个句子的时间戳各自从 0 起算，按句首已收到的采样数换算；奇数字节的分片也能解码', async () => {
  const t = await setup({ splitSentences: true, oddChunks: true });
  try {
    const { pcm, words } = await collect(
      await t.engine.start('你好，世界。', new AbortController().signal),
    );
    assert.equal(pcm.length, 6 * 80);
    // 第二句“世界。”的第一个字在 sentence_start 时已收到 3 个字的音频。
    assert.deepEqual(
      words.map((w) => [w.text, w.startMs]),
      [...'你好，世界。'].map((c, i) => [c, i * 10]),
    );
    assert.equal(pcm[3 * 80], sampleValue(0));
  } finally {
    await t.close();
  }
});

test('MiniMax：中途取消即停止产出，发 task_cancel；取消后到达的音频被丢弃；下一句照常合成', async () => {
  const t = await setup({ chunkDelayMs: 30, audioAfterCancel: 2 });
  try {
    const abort = new AbortController();
    const stream = await t.engine.start('一二三四五六七八九十', abort.signal);
    let chunks = 0;
    let afterAbort = 0;
    for await (const chunk of stream.chunks) {
      if (chunk.kind !== 'audio') continue;
      if (abort.signal.aborted) afterAbort += 1;
      chunks += 1;
      abort.abort();
    }
    assert.equal(chunks, 1);
    assert.equal(afterAbort, 0);
    const second = await collect(await t.engine.start('好的。', new AbortController().signal));
    assert.equal(second.pcm.length, 3 * 80);
    assert.equal(t.fake.events('task_cancel').length, 1);
    assert.ok(t.wire.some((w) => w.kind === 'cancel-acked'));
    assert.ok(t.wire.some((w) => w.kind === 'audio-after-cancel'));
    // 被取消的 flush 没有确认：缺省断开重连，不冒险复用。
    assert.equal(t.fake.connections, 2);
  } finally {
    await t.close();
  }
});

test('MiniMax：使用方提前停止读取等同于取消；开启复用后取消不断开连接', async () => {
  const t = await setup({ chunkDelayMs: 30 }, { reuseAfterCancel: true });
  try {
    const stream = await t.engine.start('一二三四五六七八九十', new AbortController().signal);
    for await (const chunk of stream.chunks) {
      if (chunk.kind === 'audio') break;
    }
    const next = await collect(await t.engine.start('好的。', new AbortController().signal));
    assert.equal(next.pcm.length, 3 * 80);
    assert.equal(t.fake.events('task_cancel').length, 1);
    assert.equal(t.fake.connections, 1);
  } finally {
    await t.close();
  }
});

test('MiniMax：开始前已中止的合成不发文本', async () => {
  const t = await setup();
  try {
    const abort = new AbortController();
    abort.abort();
    const { pcm } = await collect(await t.engine.start('你好。', abort.signal));
    assert.equal(pcm.length, 0);
    assert.equal(t.fake.events('task_continue').length, 0);
  } finally {
    await t.close();
  }
});

test('MiniMax：鉴权失败与缺少凭据都是引擎不可用', async () => {
  const wrong = await setup({}, {}, 'wrong-key');
  try {
    await assert.rejects(wrong.engine.start('你好。', new AbortController().signal), (error) => {
      assert.ok(error instanceof EngineError);
      assert.equal(error.auth, true);
      assert.ok(!error.message.includes('wrong-key'));
      return true;
    });
  } finally {
    await wrong.close();
  }
  const missing = await setup({}, {}, null);
  try {
    await assert.rejects(
      missing.engine.start('你好。', new AbortController().signal),
      /缺少凭据 minimax/,
    );
    assert.equal(missing.fake.connections, 0);
  } finally {
    await missing.close();
  }
  const refused = await setup({ failStart: 1004 });
  try {
    await assert.rejects(refused.engine.start('你好。', new AbortController().signal), (error) => {
      assert.ok(error instanceof EngineError && error.auth);
      return true;
    });
  } finally {
    await refused.close();
  }
});

test('MiniMax：服务端空闲断开（2201）后下一句重新建连', async () => {
  const t = await setup({ idleCloseMs: 100 });
  try {
    await collect(await t.engine.start('你好。', new AbortController().signal));
    const disconnected = () => t.wire.some((w) => w.kind === 'stale' && w.code === 2201);
    for (let waited = 0; !disconnected() && waited < 5000; waited += 20) await wait(20);
    assert.ok(disconnected());
    await wait(20);
    const { pcm } = await collect(await t.engine.start('再见。', new AbortController().signal));
    assert.equal(pcm.length, 3 * 80);
    assert.equal(t.fake.connections, 2);
  } finally {
    await t.close();
  }
});

test('MiniMax：空闲时定时 ping，服务端不因空闲断开', async () => {
  // 服务端空闲 600ms 断开，客户端每 50ms ping：超过服务端时限的空闲期内连接保持。
  const t = await setup({ idleCloseMs: 600 }, { pingIntervalMs: 50 });
  try {
    await collect(await t.engine.start('你好。', new AbortController().signal));
    await wait(1000);
    assert.ok(t.fake.pings >= 5);
    await collect(await t.engine.start('再见。', new AbortController().signal));
    assert.equal(t.fake.connections, 1);
  } finally {
    await t.close();
  }
});

test('MiniMax：错误码——文本被拒是这一句的问题，排队过多稍后重发，中途失败与超时是引擎不可用', async () => {
  const tooLong = await setup({ rejectText: 2204 });
  try {
    await assert.rejects(
      tooLong.engine.start('你好。', new AbortController().signal),
      (error) => error instanceof RequestError && /2204/.test(error.message),
    );
  } finally {
    await tooLong.close();
  }
  const busy = await setup({ backpressureOnce: true });
  try {
    const { pcm } = await collect(await busy.engine.start('你好。', new AbortController().signal));
    assert.equal(pcm.length, 3 * 80);
    assert.equal(busy.fake.events('task_continue').length, 2);
  } finally {
    await busy.close();
  }
  const broken = await setup({ failAtChunk: { index: 1, code: 1000 } });
  try {
    const stream = await broken.engine.start('一二三四五六', new AbortController().signal);
    await assert.rejects(collect(stream), (error) => error instanceof EngineError);
  } finally {
    await broken.close();
  }
  const stuck = await setup({ mute: true });
  try {
    await assert.rejects(
      stuck.engine.start('你好。', new AbortController().signal),
      (error) => error instanceof EngineError && /首段音频超时/.test(error.message),
    );
  } finally {
    await stuck.close();
  }
});
