import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  decodeFrame,
  EngineError,
  Event,
  encodeRequest,
  jsonPayload,
  MessageType,
  VolcengineEngine,
  type VolcengineOptions,
  volcengineHeaders,
  type WireEvent,
} from '../src/index.ts';
import {
  errorFrame,
  FakeVolcengine,
  type FakeVolcengineOptions,
  sampleValue,
} from './fake-volcengine.ts';
import { collect, env, timeouts } from './helpers.ts';

const KEY = 'test-key-volcengine';
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

test('火山引擎帧：客户端请求与文档字节表一致', () => {
  // StartConnection：0x11 0x14 0x10 0x00 | int32(1) | uint32(2) | "{}"
  assert.equal(
    hex(encodeRequest(Event.StartConnection, {})),
    '11141000' + '00000001' + '00000002' + '7b7d',
  );
  // FinishSession：头 | int32(102) | uint32(12) | 会话 ID | uint32(2) | "{}"
  assert.equal(
    hex(encodeRequest(Event.FinishSession, {}, 'nxckjoejnkeg')),
    `11141000${'00000066'}${'0000000c'}${Buffer.from('nxckjoejnkeg').toString('hex')}${'00000002'}7b7d`,
  );
  assert.throws(() => encodeRequest(Event.StartSession, {}), /需要会话 ID/);
});

test('火山引擎帧：解析连接、会话、音频、错误与 gzip 帧', () => {
  const started = decodeFrame(
    Buffer.concat([
      Buffer.from('11941000000000320000000762786e77656975', 'hex'),
      Buffer.from('000000027b7d', 'hex'),
    ]),
  );
  assert.equal(started.type, MessageType.FullServerResponse);
  assert.equal(started.event, Event.ConnectionStarted);
  assert.equal(started.id, 'bxnweiu');
  assert.deepEqual(jsonPayload(started), {});
  // 文档的 ConnectionFailed 示例没有连接 ID 的字节：按整帧能否恰好读完判断。
  const meta = Buffer.from('{"status_code":45000000,"message":"unauthorized"}');
  const failed = decodeFrame(
    Buffer.concat([
      Buffer.from('1194100000000033', 'hex'),
      Buffer.from([0, 0, 0, meta.length]),
      meta,
    ]),
  );
  assert.equal(failed.event, Event.ConnectionFailed);
  assert.equal(failed.id, undefined);
  assert.equal(jsonPayload(failed)?.message, 'unauthorized');
  const audio = decodeFrame(
    Buffer.concat([
      Buffer.from('11b4000000000160', 'hex'),
      Buffer.from([0, 0, 0, 2]),
      Buffer.from('s1'),
      Buffer.from([0, 0, 0, 4, 1, 2, 3, 4]),
    ]),
  );
  assert.equal(audio.type, MessageType.AudioOnlyServer);
  assert.equal(audio.event, Event.TTSResponse);
  assert.equal(audio.id, 's1');
  assert.deepEqual([...audio.payload], [1, 2, 3, 4]);
  const error = decodeFrame(errorFrame(45000001, 'bad'));
  assert.equal(error.type, MessageType.Error);
  assert.equal(error.errorCode, 45000001);
  assert.equal(jsonPayload(error)?.error, 'bad');
  const zipped = gzipSync(Buffer.from('{"a":1}'));
  const gz = decodeFrame(
    Buffer.concat([
      Buffer.from('11941100', 'hex'),
      Buffer.from('00000098', 'hex'),
      Buffer.from([0, 0, 0, 2]),
      Buffer.from('s1'),
      Buffer.from([0, 0, 0, zipped.length]),
      zipped,
    ]),
  );
  assert.deepEqual(jsonPayload(gz), { a: 1 });
  assert.throws(() => decodeFrame(Buffer.from('1194', 'hex')), /帧太短/);
});

test('火山引擎凭据：新版控制台原样存 API Key，旧版控制台存 JSON', () => {
  assert.deepEqual(volcengineHeaders(' key-1 '), { 'X-Api-Key': 'key-1' });
  assert.deepEqual(volcengineHeaders('{"appId":"123","accessToken":"tok"}'), {
    'X-Api-App-Id': '123',
    'X-Api-Access-Key': 'tok',
  });
  assert.throws(() => volcengineHeaders('{"appId":"123"}'), /appId 与 accessToken/);
  assert.throws(() => volcengineHeaders('{oops'), /不是合法的 JSON/);
});

async function setup(
  fakeOptions: Partial<FakeVolcengineOptions> = {},
  options: Partial<VolcengineOptions> = {},
  secret: string | null = KEY,
) {
  const fake = await FakeVolcengine.start({ apiKey: KEY, ...fakeOptions });
  const wire: WireEvent[] = [];
  const engine = new VolcengineEngine(
    {
      endpoint: fake.url,
      resourceId: 'seed-tts-1.0',
      speaker: 'speaker-1',
      model: '',
      sampleRate: 8000,
      speechRate: 0,
      loudnessRate: 0,
      timestamps: 'timestamp',
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

test('火山引擎：鉴权头、会话参数，增量出音频；TTS 1.0 的时间戳随句末返回，其它会话的帧被丢弃', async () => {
  const t = await setup({ chunkDelayMs: 20, staleFrames: true });
  try {
    const stream = await t.engine.start('你好，世界。', new AbortController().signal);
    assert.ok(t.wire.filter((w) => w.kind === 'audio').length < 3);
    const { pcm, words, audioChunks } = await collect(stream);
    const headers = t.fake.headers[0] ?? {};
    assert.equal(headers['x-api-key'], KEY);
    assert.equal(headers['x-api-resource-id'], 'seed-tts-1.0');
    assert.equal(typeof headers['x-api-connect-id'], 'string');
    const session = t.fake.sessions[0] as {
      namespace: string;
      req_params: Record<string, unknown>;
    };
    assert.equal(session.namespace, 'BidirectionalTTS');
    assert.equal(session.req_params.speaker, 'speaker-1');
    assert.deepEqual(session.req_params.audio_params, {
      format: 'pcm',
      sample_rate: 8000,
      speech_rate: 0,
      loudness_rate: 0,
      enable_timestamp: true,
    });
    assert.deepEqual(
      t.fake.received.map((r) => r.event),
      [Event.StartConnection, Event.StartSession, Event.TaskRequest, Event.FinishSession],
    );
    assert.equal(audioChunks, 3);
    assert.equal(pcm.length, 6 * 80);
    for (let char = 0; char < 6; char += 1) assert.equal(pcm[char * 80 + 3], sampleValue(char));
    assert.deepEqual(
      words.map((w) => [w.text, Math.round(w.startMs)]),
      [...'你好，世界。'].map((c, i) => [c, i * 10]),
    );
    assert.ok(t.wire.some((w) => w.kind === 'stale'));
    assert.deepEqual(t.wire.find((w) => w.kind === 'done')?.usage, { text_words: 6 });
  } finally {
    await t.close();
  }
});

test('火山引擎：TTS 2.0 的字幕事件（文档未列编号）按载荷识别；旧版控制台鉴权', async () => {
  const t = await setup(
    { apiKey: undefined, appId: '123', accessToken: 'tok', timestamps: 'subtitle-event' },
    { resourceId: 'seed-tts-2.0', timestamps: 'subtitle' },
    '{"appId":"123","accessToken":"tok"}',
  );
  try {
    const { words } = await collect(await t.engine.start('你好呀', new AbortController().signal));
    assert.deepEqual(
      words.map((w) => w.text),
      ['你', '好', '呀'],
    );
    const session = t.fake.sessions[0] as { req_params: { audio_params: Record<string, unknown> } };
    assert.equal(session.req_params.audio_params.enable_subtitle, true);
  } finally {
    await t.close();
  }
});

test('火山引擎：中途取消发 CancelSession，之后到达的音频被丢弃，同一连接开新会话', async () => {
  const t = await setup({ chunkDelayMs: 30, audioAfterCancel: 2 });
  try {
    const abort = new AbortController();
    const stream = await t.engine.start('一二三四五六七八九十', abort.signal);
    let chunks = 0;
    for await (const chunk of stream.chunks) {
      if (chunk.kind !== 'audio') continue;
      chunks += 1;
      abort.abort();
    }
    assert.equal(chunks, 1);
    const next = await collect(await t.engine.start('好的。', new AbortController().signal));
    assert.equal(next.pcm.length, 3 * 80);
    assert.equal(t.fake.events(Event.CancelSession).length, 1);
    assert.ok(t.wire.some((w) => w.kind === 'audio-after-cancel'));
    assert.ok(t.wire.some((w) => w.kind === 'cancel-acked'));
    assert.equal(t.fake.connections, 1);
    assert.equal(t.fake.events(Event.StartSession).length, 2);
  } finally {
    await t.close();
  }
});

test('火山引擎：HTTP 鉴权失败、ConnectionFailed、SessionFailed 都是引擎不可用', async () => {
  const wrong = await setup({}, {}, 'wrong-key');
  try {
    await assert.rejects(
      wrong.engine.start('你好。', new AbortController().signal),
      (error) => error instanceof EngineError && error.auth && !error.message.includes('wrong-key'),
    );
  } finally {
    await wrong.close();
  }
  const refused = await setup({ connectionFailed: true });
  try {
    await assert.rejects(
      refused.engine.start('你好。', new AbortController().signal),
      (error) => error instanceof EngineError && error.auth && /unauthorized/.test(error.message),
    );
  } finally {
    await refused.close();
  }
  const failing = await setup({ sessionFailed: true });
  try {
    await assert.rejects(
      failing.engine.start('你好。', new AbortController().signal),
      (error) => error instanceof EngineError && /55000001/.test(error.message),
    );
  } finally {
    await failing.close();
  }
  const missing = await setup({}, {}, null);
  try {
    await assert.rejects(
      missing.engine.start('你好。', new AbortController().signal),
      /缺少凭据 volcengine/,
    );
  } finally {
    await missing.close();
  }
});

test('火山引擎：连接中断后下一句重新建连', async () => {
  const t = await setup();
  try {
    await collect(await t.engine.start('你好。', new AbortController().signal));
    t.fake.drop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { pcm } = await collect(await t.engine.start('再见。', new AbortController().signal));
    assert.equal(pcm.length, 3 * 80);
    assert.equal(t.fake.connections, 2);
  } finally {
    await t.close();
  }
});
