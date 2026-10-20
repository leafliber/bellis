import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ManualClock } from '@bellis/kernel';
import {
  CloudTtsService,
  SpeechService,
  type Synthesis,
  type TtsEngine,
  TtsExpiredError,
  TtsService,
} from '@bellis/speech';
import { type FromPage, StageService } from '@bellis/stage';
import { MinimaxEngine, type MinimaxOptions, type WireEvent } from '../src/index.ts';
import { FakeMinimax, type FakeMinimaxOptions } from './fake-minimax.ts';
import { FakeVolcengine } from './fake-volcengine.ts';
import { CLOUD_GRANT, collect, entry, env, timeouts, until, wait, world } from './helpers.ts';

/**
 * MiniMax 到每分钟请求数上限时安静等待（R-10，发声文档“云端 TTS”的限流）。
 * 计时全部走手动时钟：窗口与首包超时由测试推进，本机网络往返用“等条件”，不用固定的 sleep。
 */

const KEY = 'test-key-minimax';
const VOLC_KEY = 'volc-key-123456';

/** 让已经排队的微任务与本机 I/O 回调跑一轮。 */
const tick = () => new Promise((resolve) => setImmediate(resolve));

const signal = () => new AbortController().signal;

async function setup(fakeOptions: Partial<FakeMinimaxOptions> = {}, rpm = 2) {
  const fake = await FakeMinimax.start({ apiKey: KEY, ...fakeOptions });
  const clock = new ManualClock();
  const wire: WireEvent[] = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const options: MinimaxOptions = {
    endpoint: fake.url,
    model: 'speech-2.8-turbo',
    voiceId: 'voice-1',
    sampleRate: 8000,
    speed: 1,
    vol: 1,
    pitch: 0,
    emotion: '',
    languageBoost: '',
    subtitleType: 'word_streaming',
    pingIntervalMs: 30_000,
    rpm,
  };
  const engine = new MinimaxEngine(
    options,
    // 连接在等待期间不因空闲被主动关闭（另有用例覆盖空闲断开后重连）。
    { ...timeouts, idleCloseMs: 600_000 },
    { ...env(KEY, wire, clock), log: (event, fields) => logs.push({ event, fields }) },
  );
  return {
    fake,
    clock,
    engine,
    wire,
    logs,
    kinds: (kind: string) => wire.filter((w) => w.kind === kind),
    texts: () => fake.events('task_continue').map((r) => r.text),
    async close() {
      engine.close();
      await fake.close();
    },
  };
}

test('MiniMax 限流：本地计数到每分钟上限时，下一句安静等到窗口里空出名额再发', async () => {
  const t = await setup({}, 2);
  try {
    await collect(await t.engine.start('一。', signal()));
    t.clock.advance(10_000);
    await collect(await t.engine.start('二。', signal()));
    // 最近 60 秒内已发出 2 句：第三句等到第一句滑出窗口（60 000ms）。
    const third = t.engine.start('三。', signal());
    await until(() => t.kinds('rate-wait').length === 1);
    const [waitEvent] = t.kinds('rate-wait');
    assert.equal(waitEvent?.reason, 'rpm');
    assert.equal(waitEvent?.waitMs, 50_000);
    assert.deepEqual(t.engine.waiting, { reason: 'rpm', until: 60_000 });
    t.clock.advance(49_999);
    await tick();
    assert.equal(t.fake.events('task_continue').length, 2, '窗口没空出名额前不发出');
    t.clock.advance(1);
    const { pcm } = await collect(await third);
    assert.equal(pcm.length, 2 * 80);
    assert.deepEqual(t.texts(), ['一。', '二。', '三。']);
    assert.equal(t.kinds('text-sent').at(-1)?.at, 60_000);
    assert.equal(t.kinds('rate-resumed')[0]?.waitedMs, 50_000);
    assert.equal(t.engine.waiting, undefined);
    assert.equal(t.fake.connections, 1);
    // 日志写明原因与时长，不写文本。
    assert.deepEqual(
      t.logs.filter((l) => l.event.startsWith('tts.rate-limit')),
      [
        {
          event: 'tts.rate-limit-wait',
          fields: { engine: 'minimax', reason: 'rpm', waitMs: 50_000, rpm: 2, sent: 2 },
        },
        { event: 'tts.rate-limit-resumed', fields: { engine: 'minimax', waitedMs: 50_000 } },
      ],
    );
    assert.ok(!JSON.stringify(t.logs).includes('三'));
  } finally {
    await t.close();
  }
});

test('MiniMax 限流：首包超时从真正发出文本时起算，等待的时间不算进去', async () => {
  // 服务端收到文本后不出声：首包超时（1000ms）是唯一会让这一句结束的时限。
  const t = await setup({ mute: true }, 1);
  try {
    const first = t.engine.start('一。', signal());
    await until(() => t.fake.events('task_flush').length === 1);
    t.clock.advance(1000);
    await assert.rejects(first, /首段音频超时（1000ms）/);
    // 第一句在 0ms 发出：第二句等到 60 000ms，远超首包超时。
    let settled = false;
    const second = t.engine.start('二。', signal());
    second.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await until(() => t.kinds('rate-wait').length === 1);
    assert.equal(t.kinds('rate-wait')[0]?.waitMs, 59_000);
    t.clock.advance(59_000);
    await until(() => t.fake.events('task_continue').length === 2);
    t.clock.advance(999);
    await tick();
    assert.equal(settled, false, '发出文本后不到首包超时，这一句仍在等音频');
    t.clock.advance(1);
    await assert.rejects(second, /首段音频超时（1000ms）/);
  } finally {
    await t.close();
  }
});

test('MiniMax 限流：被 1002 拒绝时从被拒时起等满一个窗口，在新连接上重发同一句并播出', async () => {
  const t = await setup({ rateLimitTexts: 1 }, 20);
  try {
    const pending = t.engine.start('你好。', signal());
    await until(() => t.kinds('rate-wait').length === 1);
    assert.equal(t.fake.rateLimited, 1);
    assert.ok(t.kinds('rate-limited').length === 1);
    assert.equal(t.kinds('rate-wait')[0]?.reason, '1002');
    assert.equal(t.kinds('rate-wait')[0]?.waitMs, 60_000);
    assert.deepEqual(t.engine.waiting, { reason: '1002', until: 60_000 });
    t.clock.advance(59_999);
    await tick();
    assert.equal(t.fake.events('task_continue').length, 1);
    t.clock.advance(1);
    const { pcm } = await collect(await pending);
    assert.equal(pcm.length, 3 * 80);
    assert.deepEqual(t.texts(), ['你好。', '你好。']);
    assert.equal(t.fake.connections, 2);
    assert.equal(t.kinds('failed').length, 1, '只有被拒的那一次');
  } finally {
    await t.close();
  }
});

test('MiniMax 限流：等待中被中止或引擎关闭时立即取消等待，这一句不再发出', async () => {
  const t = await setup({}, 1);
  try {
    await collect(await t.engine.start('一。', signal()));
    const abort = new AbortController();
    const pending = t.engine.start('二。', abort.signal);
    await until(() => t.kinds('rate-wait').length === 1);
    abort.abort();
    assert.equal((await collect(await pending)).pcm.length, 0);
    assert.equal(t.kinds('rate-canceled').length, 1);
    assert.equal(t.engine.waiting, undefined);
    assert.ok(t.logs.some((l) => l.event === 'tts.rate-limit-canceled'));
    // 窗口过去之后下一句照常发出；被中止的那一句始终没有发出。
    t.clock.advance(60_000);
    await collect(await t.engine.start('三。', signal()));
    assert.deepEqual(t.texts(), ['一。', '三。']);
    const closing = t.engine.start('四。', signal());
    await until(() => t.kinds('rate-wait').length === 2);
    t.engine.close();
    assert.equal((await collect(await closing)).pcm.length, 0);
    t.clock.advance(120_000);
    await tick();
    assert.deepEqual(t.texts(), ['一。', '三。']);
  } finally {
    await t.close();
  }
});

test('MiniMax 限流：要等、而额度恢复时发言已过期（含此刻已过期）就不等，不发请求；不用等时不看过期', async () => {
  const t = await setup({}, 1);
  try {
    // 不用等：发言已过期也照常发出（已开口的发言照常说完）。
    await collect(await t.engine.start('一。', signal(), { expiresAt: -1 }));
    // 这一分钟的名额已用掉，60 000ms 才恢复：恰在那时过期、此刻已过期，都不等。
    await assert.rejects(t.engine.start('二。', signal(), { expiresAt: 60_000 }), TtsExpiredError);
    await assert.rejects(t.engine.start('三。', signal(), { expiresAt: 0 }), TtsExpiredError);
    assert.deepEqual(t.texts(), ['一。']);
    assert.equal(t.kinds('rate-wait').length, 0);
    assert.deepEqual(
      t.kinds('rate-expired').map((w) => [w.reason, w.waitMs, w.expiresInMs]),
      [
        ['rpm', 60_000, 60_000],
        ['rpm', 60_000, 0],
      ],
    );
    assert.equal(t.logs.filter((l) => l.event === 'tts.rate-limit-expired').length, 2);
    assert.equal(t.engine.waiting, undefined);
    // 等完前不会过期：照常等、照常发。
    const pending = t.engine.start('四。', signal(), { expiresAt: 60_001 });
    await until(() => t.kinds('rate-wait').length === 1);
    t.clock.advance(60_000);
    assert.equal((await collect(await pending)).pcm.length, 2 * 80);
    assert.deepEqual(t.texts(), ['一。', '四。']);
  } finally {
    await t.close();
  }
});

test('MiniMax 限流：被 1002 拒绝后要等满一个窗口，而发言届时已过期：不再重发', async () => {
  const t = await setup({ rateLimitTexts: 1 }, 20);
  try {
    await assert.rejects(
      t.engine.start('你好。', signal(), { expiresAt: 30_000 }),
      TtsExpiredError,
    );
    assert.deepEqual(t.texts(), ['你好。']);
    assert.equal(t.kinds('rate-expired')[0]?.reason, '1002');
    // 窗口过去之后，下一句照常发出。
    t.clock.advance(60_000);
    assert.equal((await collect(await t.engine.start('再见。', signal()))).pcm.length, 3 * 80);
    assert.deepEqual(t.texts(), ['你好。', '再见。']);
  } finally {
    await t.close();
  }
});

async function drain(synthesis: Synthesis): Promise<number> {
  let samples = 0;
  for await (const frame of synthesis.frames) samples += frame.length;
  return samples;
}

/** 两家厂商都指向本机假服务器的云端 TTS 配置。 */
function cloudConfig(minimax: FakeMinimax, volcengine: FakeVolcengine, rpm: number) {
  return {
    primary: 'minimax',
    fallback: ['volcengine'],
    retryAfterMs: 600_000,
    minimax: {
      egress: true,
      endpoint: minimax.url,
      model: 'speech-2.8-turbo',
      voiceId: 'v',
      sampleRate: 8000,
      rpm,
    },
    volcengine: {
      egress: true,
      endpoint: volcengine.url,
      resourceId: 'seed-tts-1.0',
      speaker: 's',
      sampleRate: 8000,
      timestamps: 'timestamp',
    },
  };
}

const cases: Array<[string, Partial<FakeMinimaxOptions>, number, RegExp]> = [
  ['本地计数到上限', {}, 1, /本地计数到每分钟上限/],
  ['厂商以 1002 拒绝', { rateLimitTexts: 1 }, 20, /厂商限流/],
];

for (const [name, fakeOptions, rpm, why] of cases) {
  test(`云端 TTS 插件：${name}时安静等待，不冷却、不换厂商，引擎照常就绪，路由不切换`, async () => {
    const minimax = await FakeMinimax.start({ apiKey: KEY, ...fakeOptions });
    const volcengine = await FakeVolcengine.start({ apiKey: VOLC_KEY });
    const clock = new ManualClock();
    const w = await world(
      [
        entry('tts', 'tts-cloud', {
          config: cloudConfig(minimax, volcengine, rpm),
          grant: CLOUD_GRANT,
        }),
        entry('router', 'tts-router', { config: { order: ['cloud', 'subtitles'] } }),
      ],
      { minimax: KEY, volcengine: VOLC_KEY },
      clock,
    );
    try {
      const tts = w.service(TtsService);
      const engine = w.service<TtsEngine>(CloudTtsService);
      // 本地计数的用例先用掉这一分钟的名额；1002 的用例第一句就被拒。
      if (rpm === 1) assert.equal(await drain(await tts.synthesize('一。', signal())), 2 * 80);
      const pending = tts.synthesize('你好。', signal());
      await until(() => w.logs.some((l) => l.event === 'tts.rate-limit-wait'));
      assert.equal(engine.ready, true);
      assert.match(engine.status, /^可用：minimax、volcengine；minimax 等待限流/);
      assert.match(engine.status, why);
      clock.advance(60_000);
      assert.equal(await drain(await pending), 3 * 80);
      assert.equal(volcengine.connections, 0, '不换厂商');
      assert.deepEqual(w.events('tts.switched'), [], '路由与插件都没有切换');
      assert.ok(!w.logs.some((l) => l.event === 'tts.engine-failed'), '不算故障、不冷却');
      assert.equal(engine.status, '可用：minimax、volcengine');
    } finally {
      await w.close();
      await minimax.close();
      await volcengine.close();
    }
  });
}

test('云端 TTS 插件：要等限流、额度恢复时发言已过期：不等，不换厂商、不冷却，路由不改用只出字幕', async () => {
  const minimax = await FakeMinimax.start({ apiKey: KEY });
  const volcengine = await FakeVolcengine.start({ apiKey: VOLC_KEY });
  const clock = new ManualClock();
  const w = await world(
    [
      entry('tts', 'tts-cloud', {
        config: cloudConfig(minimax, volcengine, 1),
        grant: CLOUD_GRANT,
      }),
      entry('router', 'tts-router', { config: { order: ['cloud', 'subtitles'] } }),
    ],
    { minimax: KEY, volcengine: VOLC_KEY },
    clock,
  );
  try {
    const tts = w.service(TtsService);
    const engine = w.service<TtsEngine>(CloudTtsService);
    await drain(await tts.synthesize('一。', signal()));
    await assert.rejects(
      tts.synthesize('你好。', signal(), { expiresAt: 5000 }),
      (error) => error instanceof TtsExpiredError && /发言届时已过期/.test(error.message),
    );
    assert.equal(volcengine.connections, 0, '不换厂商');
    assert.deepEqual(w.events('tts.switched'), [], '路由不改用只出字幕');
    assert.ok(!w.logs.some((l) => l.event === 'tts.engine-failed'), '不算故障、不冷却');
    assert.equal(engine.ready, true);
    assert.equal(engine.status, '可用：minimax、volcengine');
    assert.deepEqual(
      minimax.events('task_continue').map((r) => r.text),
      ['一。'],
    );
  } finally {
    await w.close();
    await minimax.close();
    await volcengine.close();
  }
});

test('云端 TTS 插件（回归）：服务端出错与首包超时仍按原规则冷却并改用另一家', async () => {
  for (const fakeOptions of [{ failStart: 1000 }, { mute: true }] as const) {
    const minimax = await FakeMinimax.start({ apiKey: KEY, ...fakeOptions });
    const volcengine = await FakeVolcengine.start({ apiKey: VOLC_KEY });
    const w = await world(
      [
        entry('tts', 'tts-cloud', {
          config: { ...cloudConfig(minimax, volcengine, 20), firstAudioTimeoutMs: 200 },
          grant: CLOUD_GRANT,
        }),
      ],
      { minimax: KEY, volcengine: VOLC_KEY },
    );
    try {
      const engine = w.service<TtsEngine>(CloudTtsService);
      assert.equal(await drain(await engine.synthesize('你好。', signal())), 3 * 80);
      assert.equal(volcengine.connections, 1);
      assert.equal(engine.status, '可用：volcengine', 'minimax 在冷却中');
      const switched = w.events('tts.switched').map((e) => e.data as Record<string, unknown>);
      assert.deepEqual(
        switched.map((d) => [d.from, d.to]),
        [['minimax', 'volcengine']],
      );
      assert.ok(w.logs.some((l) => l.event === 'tts.engine-failed'));
      assert.ok(!w.logs.some((l) => l.event === 'tts.rate-limit-wait'));
    } finally {
      await w.close();
      await minimax.close();
      await volcengine.close();
    }
  }
});

/**
 * 推进手动时钟，每步（10ms）之间让异步流程跑一轮，直到条件成立。`io` 时每 200ms 模拟时间再让出一点真实时间，
 * 等本机网络送来的音频。
 */
async function advanceUntil(
  clock: ManualClock,
  condition: () => boolean,
  limitMs: number,
  io = false,
) {
  for (let elapsed = 0; !condition(); elapsed += 10) {
    if (elapsed > limitMs) throw new Error(`条件未在模拟时间 ${limitMs}ms 内满足`);
    clock.advance(10);
    await (io && elapsed % 200 === 0 ? wait(1) : tick());
  }
}

/**
 * 手动时钟下的发声链路。播放要推进时钟，而音频经本机网络按真实时间到达：建连与合成的时限放宽到测试推进不到的长度，
 * 免得推进时钟时误判超时。
 */
async function speechWorld(minimax: FakeMinimax, volcengine: FakeVolcengine, consume = true) {
  const clock = new ManualClock();
  const w = await world(
    [
      entry('stage-page', 'stage-page-sim'),
      entry('stage', 'stage-service'),
      entry('tts', 'tts-cloud', {
        config: {
          ...cloudConfig(minimax, volcengine, 1),
          fallback: [],
          connectTimeoutMs: 3_600_000,
          firstAudioTimeoutMs: 3_600_000,
          stallTimeoutMs: 3_600_000,
          idleCloseMs: 3_600_000,
        },
        grant: CLOUD_GRANT,
      }),
      // 只出字幕排在后面：用来核对限流不会让路由降级。
      entry('router', 'tts-router', { config: { order: ['cloud', 'subtitles'] } }),
      entry('speech', 'speech-arbiter', { grant: ['speech.output'] }),
    ],
    { minimax: KEY },
    clock,
  );
  assert.deepEqual(w.safety.requestMode('M0'), { ok: true });
  const started: string[] = [];
  w.service(StageService).onEvent((event: FromPage) => {
    if (event.kind === 'started') started.push(event.sentenceId);
  });
  // 先用掉这一分钟的名额（rpm 为 1）。
  if (consume) await drain(await w.service(CloudTtsService).synthesize('一。', signal()));
  const speak = (id: string, text: string, expiresAt: number) => {
    const outcome = { done: false };
    const promise = w
      .service(SpeechService)
      .request({
        id,
        source: 'danmaku-reply',
        text,
        expiresAt,
        preempt: 'sentence',
        inputs: [],
        untrusted: false,
      })
      .finally(() => {
        outcome.done = true;
      });
    return Object.assign(outcome, { promise });
  };
  return { w, clock, started, speak };
}

test('发声链路：已开口的发言，后一句要等限流而发言已过期或等完会过期：不等、不发请求、不换引擎，按过期结束', async () => {
  // 每字 2 秒：“你好。”约 6 秒播完，首包经本机网络到达时手动时钟远没走到过期。
  // 发言在播第一句时过期（3 秒），或此刻未过期、但等完之前会过期（30 秒）。
  for (const ttl of [3000, 30_000]) {
    const minimax = await FakeMinimax.start({ apiKey: KEY, samplesPerChar: 16_000 });
    const volcengine = await FakeVolcengine.start({ apiKey: VOLC_KEY });
    const { w, clock, started, speak } = await speechWorld(minimax, volcengine, false);
    try {
      const reply = speak('u1', '你好。再见。', clock.now() + ttl);
      // 音频经本机网络按真实时间到达：每推进一步也让出一点真实时间。
      await advanceUntil(clock, () => reply.done, 10_000, true);
      const result = await reply.promise;
      assert.equal(result.end, 'expired', `ttl ${ttl}`);
      assert.match(result.reason ?? '', /发言届时已过期/);
      assert.equal(result.heard, '你好。', '写回只含已播出的第一句');
      assert.ok(clock.now() < 10_000, '不等窗口');
      assert.deepEqual(started, ['u1#0']);
      assert.deepEqual(
        minimax.events('task_continue').map((r) => r.text),
        ['你好。'],
      );
      assert.deepEqual(w.events('tts.switched'), [], '不改用只出字幕');
      assert.ok(w.logs.some((l) => l.event === 'tts.rate-limit-expired'));
      assert.ok(!w.logs.some((l) => l.event === 'tts.rate-limit-wait'));
      assert.ok(!w.logs.some((l) => l.event === 'tts.engine-failed'));
    } finally {
      await w.close();
      await minimax.close();
      await volcengine.close();
    }
  }
});

test('发声链路：已开口的发言，后一句要等限流、等完前不会过期：照常等，额度恢复后照常播出', async () => {
  const minimax = await FakeMinimax.start({ apiKey: KEY });
  const volcengine = await FakeVolcengine.start({ apiKey: VOLC_KEY });
  const { w, clock, started, speak } = await speechWorld(minimax, volcengine, false);
  try {
    const reply = speak('u1', '你好。再见。', 120_000);
    await advanceUntil(
      clock,
      () => w.logs.some((l) => l.event === 'tts.rate-limit-wait'),
      5000,
      true,
    );
    assert.deepEqual(started, ['u1#0']);
    // 等待期间不需要网络：照常推进到额度恢复。
    await advanceUntil(
      clock,
      () => w.logs.some((l) => l.event === 'tts.rate-limit-resumed'),
      61_000,
    );
    await until(() => minimax.events('task_continue').length === 2);
    await advanceUntil(clock, () => reply.done, 5000, true);
    const result = await reply.promise;
    assert.equal(result.end, 'complete');
    assert.equal(result.heard, '你好。再见。');
    assert.deepEqual(started, ['u1#0', 'u1#1']);
    assert.deepEqual(w.events('tts.switched'), []);
  } finally {
    await w.close();
    await minimax.close();
    await volcengine.close();
  }
});

test('发声链路：合成中（首包迟迟不到）等到发言过期：取消合成，这一句不播出，发言按过期结束', async () => {
  // 服务端收到文本后不出声；不碰限流，过期由仲裁的定时器在合成中取消。
  const minimax = await FakeMinimax.start({ apiKey: KEY, mute: true });
  const volcengine = await FakeVolcengine.start({ apiKey: VOLC_KEY });
  const { w, clock, started, speak } = await speechWorld(minimax, volcengine, false);
  try {
    const reply = speak('u1', '你好。', clock.now() + 5000);
    await until(() => minimax.events('task_flush').length === 1);
    await advanceUntil(clock, () => reply.done, 6000);
    const result = await reply.promise;
    assert.equal(result.end, 'expired');
    assert.equal(result.reason, '合成中发言已过期');
    assert.equal(result.heard, '');
    assert.ok(clock.now() >= 5000 && clock.now() < 5100, '过期那一刻就结束');
    assert.deepEqual(started, []);
    await until(() => minimax.events('task_cancel').length === 1);
  } finally {
    await w.close();
    await minimax.close();
    await volcengine.close();
  }
});

test('发声链路：等限流时被更高优先级的发言抢占，等待立即取消，抢占者等到名额后播出', async () => {
  const minimax = await FakeMinimax.start({ apiKey: KEY });
  const volcengine = await FakeVolcengine.start({ apiKey: VOLC_KEY });
  const { w, clock, started } = await speechWorld(minimax, volcengine);
  try {
    const speech = w.service(SpeechService);
    const request = (id: string, source: 'chatter' | 'scheduled', text: string) =>
      speech.request({
        id,
        source,
        text,
        expiresAt: Number.POSITIVE_INFINITY,
        preempt: 'sentence',
        inputs: [],
        untrusted: false,
      });
    const chatter = request('c1', 'chatter', '你好。');
    await until(() => w.logs.some((l) => l.event === 'tts.rate-limit-wait'));
    let done = false;
    const scheduled = request('s1', 'scheduled', '整点提醒。').finally(() => {
      done = true;
    });
    const first = await chatter;
    assert.equal(first.end, 'preempted');
    assert.ok(w.logs.some((l) => l.event === 'tts.rate-limit-canceled'));
    assert.equal(clock.now(), 0, '抢占那一刻就取消，不等窗口');
    // 抢占者也要等这一分钟的名额（第一句在 0ms 发出）。
    await until(() => w.logs.filter((l) => l.event === 'tts.rate-limit-wait').length === 2);
    clock.advance(60_000);
    await until(() => minimax.events('task_continue').length === 2);
    // 音频经本机网络按真实时间到达：每推进一步也让出一点真实时间。
    await advanceUntil(clock, () => done, 10_000, true);
    const second = await scheduled;
    assert.equal(second.end, 'complete');
    assert.equal(second.heard, '整点提醒。');
    assert.deepEqual(
      minimax.events('task_continue').map((r) => r.text),
      ['一。', '整点提醒。'],
    );
    assert.deepEqual(started, ['s1#0']);
  } finally {
    await w.close();
    await minimax.close();
    await volcengine.close();
  }
});
