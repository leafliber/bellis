import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkDirector,
  FALLBACK_LINE,
  type Scenario,
  SENTENCES,
  simulate,
  type TraceEntry,
} from '../src/index.ts';

const base: Scenario = {
  seed: 0,
  moderation: { enabled: false, onError: 'skip', delayMs: 0 },
  ttsSlow: false,
  danmaku: [],
  outputs: [],
  announcements: [],
  operator: [],
  durationMs: 20_000,
};

const kinds = (trace: readonly TraceEntry[], kind: string) => trace.filter((e) => e.kind === kind);
const text = (indices: readonly number[]) => indices.map((i) => SENTENCES[i] ?? '').join('');

/**
 * 四条弹幕各触发一次按块回放的调用，都在文本开始时开口：正常结束；最终输出不合法；流到一半出错；开口之后才到
 * 截止时间（第三次失败，告警并降级）。
 */
const streaming: Scenario = {
  ...base,
  danmaku: [
    { atMs: 0, viewer: 0, nickname: 0, text: 1 },
    { atMs: 4000, viewer: 1, nickname: 1, text: 0 },
    { atMs: 8000, viewer: 2, nickname: 2, text: 1 },
    { atMs: 12_000, viewer: 3, nickname: 3, text: 0 },
  ],
  outputs: [
    {
      kind: 'stream',
      sentences: [0, 1],
      target: 1,
      chunkChars: 4,
      chunkMs: 60,
      end: { kind: 'ok' },
    },
    {
      kind: 'stream',
      sentences: [0, 1, 5],
      target: 2,
      chunkChars: 5,
      chunkMs: 60,
      end: { kind: 'invalid' },
    },
    {
      kind: 'stream',
      sentences: [0, 1, 5],
      target: 3,
      chunkChars: 5,
      chunkMs: 60,
      end: { kind: 'error', error: 'network', cut: 75 },
    },
    {
      kind: 'stream',
      sentences: [1, 1, 1],
      target: 4,
      chunkChars: 6,
      chunkMs: 150,
      end: { kind: 'ok' },
    },
  ],
};

for (const mode of ['M0', 'M2'] as const) {
  test(`增量开口（${mode}）：正常结束的照常播完；最终不合法、中途出错、开口后超时的文本流以错误结束，不播过渡语`, async () => {
    const result = await simulate({ ...streaming, mode });
    assert.deepEqual(result.violations, []);
    const { trace } = result.history;

    // 四次调用都在文本开始时开口（文本为流），没有整段交给发声的发言，也没有过渡语。
    const requested = kinds(trace, 'speech.requested').filter((e) =>
      String(e.data.id).startsWith('director:'),
    );
    assert.deepEqual(
      requested.map((e) => e.data.text),
      [null, null, null, null],
    );
    assert.ok(!requested.some((e) => e.data.text === FALLBACK_LINE));
    const utterances = requested.map((e) => {
      const fact = kinds(trace, 'fact.utterance').find((u) => u.data.id === e.data.id);
      assert.ok(fact, `发言 ${String(e.data.id)} 写回了`);
      return fact;
    });
    const ended = (call: number) =>
      trace.find(
        (e) =>
          e.data.call === call &&
          (e.kind === 'llm.output' || e.kind === 'llm.error' || e.kind === 'llm.aborted'),
      ) as TraceEntry;

    // 正常结束：模型还在输出时就已开口，第一句在模型输出完之前就开始播出；校验通过后完整播完。
    const first = ended(0);
    assert.equal(first.kind, 'llm.output');
    assert.ok((requested[0]?.seq ?? Number.POSITIVE_INFINITY) < first.seq);
    const started = kinds(trace, 'page.started').find((e) =>
      String(e.data.sentenceId).startsWith(`${String(requested[0]?.data.id)}#`),
    );
    assert.ok(started && started.seq < first.seq, '第一句在模型输出完之前开始播出');
    assert.deepEqual(
      [utterances[0]?.data.end, utterances[0]?.data.heard],
      ['complete', text([0, 1])],
    );

    // 最终不合法、中途出错、开口后超时：文本流以错误结束，没有完整播完，播出的只是文本的开头。
    assert.equal(ended(1).kind, 'llm.output');
    assert.equal(ended(2).kind, 'llm.error');
    assert.deepEqual(ended(3).data, { call: 3, deadline: true });
    for (const [i, sentences] of [
      [1, [0, 1, 5]],
      [2, [0, 1, 5]],
      [3, [1, 1, 1]],
    ] as const) {
      const fact = utterances[i];
      assert.notEqual(fact?.data.end, 'complete', `第 ${i} 次`);
      const heard = String(fact?.data.heard);
      assert.ok(text(sentences).startsWith(heard) && heard !== text(sentences), `第 ${i} 次`);
    }
    // 不合法的那次：错误之前读出的句子播完，还没凑成的最后一句不播。
    assert.equal(utterances[1]?.data.end, 'unavailable');
    assert.equal(utterances[1]?.data.heard, text([0, 1]));

    // 连续三次失败：第三次（开口后超时）告警并请求降级。
    assert.deepEqual(
      kinds(trace, 'fact.director.alarmed').map((e) => [e.data.count, e.data.detail]),
      [[3, 'timeout']],
    );
  });
}

test('冷场闲聊：开口之前被新弹幕取消，开口之后新弹幕排队、等它结束', async () => {
  const result = await simulate({
    ...base,
    // 冷场 4 秒后闲聊：第一次在文本开始之前来了弹幕，第二次在开口之后来了弹幕。
    danmaku: [
      { atMs: 4300, viewer: 0, nickname: 0, text: 1 },
      { atMs: 9200, viewer: 1, nickname: 1, text: 0 },
    ],
    outputs: [
      {
        kind: 'stream',
        sentences: [5],
        target: null,
        chunkChars: 4,
        chunkMs: 60,
        end: { kind: 'ok' },
      },
      { kind: 'reply', sentences: [0], target: 1 },
      {
        kind: 'stream',
        sentences: [1, 5],
        target: null,
        chunkChars: 6,
        chunkMs: 60,
        end: { kind: 'ok' },
      },
      { kind: 'reply', sentences: [0], target: 2 },
    ],
  });
  assert.deepEqual(result.violations, []);
  const { trace } = result.history;
  const requests = kinds(trace, 'llm.request');
  assert.deepEqual(
    requests.slice(0, 4).map((e) => e.data.candidates),
    [[], ['c-d1'], [], ['c-d2']],
  );
  // 第一次：还没开口就被取消；第三次：开口之后弹幕到达，调用照常结束，弹幕排到它之后。
  assert.deepEqual(
    kinds(trace, 'llm.aborted').map((e) => e.data),
    [{ call: 0, deadline: false }],
  );
  const chatter = kinds(trace, 'speech.requested').find((e) => e.data.text === null);
  const second = kinds(trace, 'danmaku.delivered')[1] as TraceEntry;
  const output = kinds(trace, 'llm.output').find((e) => e.data.call === 2) as TraceEntry;
  assert.ok(chatter && chatter.seq < second.seq && second.seq < output.seq);
  assert.ok((requests[3]?.seq ?? 0) > output.seq);
  const fact = kinds(trace, 'fact.utterance').find((e) => e.data.id === chatter.data.id);
  assert.deepEqual([fact?.data.source, fact?.data.end], ['chatter', 'complete']);
});

test('增量开口的不变量能发现违例：没有立即开口、开口后被取消、失败后完整结束、播出没送出的文本', () => {
  const at = (seq: number, kind: string, data: Record<string, unknown>): TraceEntry => ({
    seq,
    at: seq,
    kind,
    data,
  });
  const head = '{"action":"speak","replyTo":"c-d1","text":"';
  const start = [
    at(0, 'world.start', { restarts: 0 }),
    at(1, 'llm.request', { call: 0, candidates: ['c-d1'] }),
    at(2, 'llm.chunk', { call: 0, delta: head }),
  ];
  const opened = at(3, 'speech.requested', { id: 'director:d#b0:1', text: null });
  const check = (trace: TraceEntry[]) =>
    checkDirector({ trace, events: [], moderationEnabled: false });

  assert.match(
    check([...start, at(3, 'llm.chunk', { call: 0, delta: '你好' })]).join(),
    /没有立即开口/,
  );
  assert.match(
    check([
      at(0, 'world.start', { restarts: 0 }),
      at(1, 'llm.request', { call: 0, candidates: [] }),
      at(2, 'llm.chunk', { call: 0, delta: head }),
      at(3, 'speech.requested', { id: 'director:d#b0:1', text: null }),
    ]).join(),
    /不是在一次调用刚送出说话意图的开头时请求的/,
  );
  assert.match(
    check([...start, opened, at(4, 'llm.aborted', { call: 0, deadline: false })]).join(),
    /开口之后被取消/,
  );
  assert.match(
    check([
      ...start,
      opened,
      at(4, 'llm.chunk', { call: 0, delta: '你好。"}' }),
      at(5, 'llm.error', { call: 0, kind: 'network' }),
      at(6, 'fact.utterance', { id: 'director:d#b0:1', end: 'complete' }),
    ]).join(),
    /失败之后完整结束/,
  );
  assert.match(
    check([
      ...start,
      opened,
      at(4, 'llm.chunk', { call: 0, delta: '你好。' }),
      at(5, 'page.begin', { sentenceId: 'director:d#b0:1#0', subtitle: '再见。' }),
      at(6, 'fact.utterance', { id: 'director:d#b0:1', end: 'stopped' }),
    ]).join(),
    /播出的“再见。”不在第 0 次调用已经送出的文本里/,
  );
  // 开口之后正常结束：不再另交发声，也不缺过渡语。
  assert.deepEqual(
    check([
      ...start,
      opened,
      at(4, 'llm.chunk', { call: 0, delta: '你好。"}' }),
      at(5, 'llm.output', { call: 0, output: `${head}你好。"}` }),
      at(6, 'page.begin', { sentenceId: 'director:d#b0:1#0', subtitle: '你好。' }),
      at(7, 'fact.utterance', { id: 'director:d#b0:1', end: 'complete' }),
    ]),
    [],
  );
});
