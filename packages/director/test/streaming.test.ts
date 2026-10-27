import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeadlineError } from '@bellis/kernel';
import type { Memory, RecalledMemory } from '@bellis/memory';
import type { SpeechRequest, UtteranceOutcome } from '@bellis/speech';
import { LlmError, MAX_SPEAK_TEXT } from '../src/index.ts';
import { candidate, type PendingCall, type World, world } from './helpers.ts';

/** 读一段流式发言的文本：读到的各段与结局（正常结束为 `done`，出错为错误的说明）。 */
function reader(text: SpeechRequest['text'] | undefined, stopAfter = Number.POSITIVE_INFINITY) {
  assert.ok(text !== undefined && typeof text !== 'string', '文本应当是流');
  const got: string[] = [];
  const state: { end?: string } = {};
  void (async () => {
    try {
      for await (const piece of text) {
        got.push(piece);
        // 仲裁提前停止读取（例如被抢占）。
        if (got.length >= stopAfter) break;
      }
      state.end = 'done';
    } catch (error) {
      state.end = error instanceof Error ? error.message : String(error);
    }
  })();
  return { got, state, text: () => got.join('') };
}

/** 流式客户端：依次报来正文增量，每段之后让异步流程跑完。 */
async function stream(w: World, call: PendingCall, ...deltas: string[]) {
  for (const delta of deltas) {
    call.options?.onOutput?.(delta);
    await w.flush();
  }
}

const outcome = (id: string, heard: string): UtteranceOutcome => ({
  id,
  source: 'danmaku-reply',
  heard,
  interruptedMidSentence: false,
  end: 'complete',
  skipped: [],
});

test('增量开口：模型还没结束，发声请求已经发出；文本逐段送入，整段校验一致后正常结束', async () => {
  const w = await world({ telemetry: true, config: { replyTtlMs: 20_000 } });
  try {
    const target = candidate({ id: 'c-a' });
    await w.arrive(target);
    const call = w.call(0);
    await w.advance(300);
    await stream(w, call, '{"action":"speak","re', 'plyTo":"c-a","te');
    assert.equal(w.spoken.length, 0, '文本还没开始');
    await stream(w, call, 'xt":"你好');
    assert.equal(w.spoken.length, 1, '文本一开始就交给发声');
    const request = w.spoken[0] as SpeechRequest;
    assert.deepEqual(
      {
        source: request.source,
        preempt: request.preempt,
        inputs: request.inputs,
        untrusted: request.untrusted,
        expiresAt: request.expiresAt,
      },
      {
        source: 'danmaku-reply',
        preempt: 'sentence',
        inputs: target.sources,
        untrusted: true,
        expiresAt: 300 + 20_000,
      },
    );
    const read = reader(request.text);
    await w.flush();
    assert.equal(read.text(), '你好');
    await stream(w, call, '呀！\\n欢迎', '来到直播间。"', ',"memories":null}');
    assert.equal(read.text(), '你好呀！\n欢迎来到直播间。');
    assert.equal(read.state.end, undefined, '整段校验之前不结束');
    call.resolve(
      '{"action":"speak","replyTo":"c-a","text":"你好呀！\\n欢迎来到直播间。","memories":null}',
    );
    await w.flush();
    assert.equal(read.state.end, 'done');
    assert.equal(w.spoken.length, 1, '不再整段交一次');
    assert.deepEqual(w.logged('director.output-dropped'), []);
    w.finish[0]?.(outcome(request.id, '你好呀！'));
    await w.flush();
    const span = w.spans().find((s) => s.name === 'chat test-model');
    assert.equal(span?.attributes['bellis.director.streamed'], true);
    assert.equal(span?.attributes['bellis.director.action'], 'speak');
    assert.equal(span?.error, false);
    assert.deepEqual(
      span?.events.map((e) => e.name),
      ['bellis.director.speech_started'],
    );
    // 开口的事件在第三段增量到达的时刻（调用开始后 300ms）。
    assert.equal(Number(((span?.events[0]?.time ?? 0n) - (span?.start ?? 0n)) / 1_000_000n), 300);
    const raw = JSON.stringify(w.spans(), (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    assert.ok(!raw.includes('你好'), '不记文本');
  } finally {
    await w.close();
  }
});

test('增量开口：仲裁提前停止读取后，扫到的文本照样记下，整段校验不受影响', async () => {
  const w = await world();
  try {
    await w.arrive(candidate({ id: 'c-a' }));
    const call = w.call(0);
    await stream(w, call, '{"action":"speak","replyTo":"c-a","text":"第一句。');
    const read = reader(w.spoken[0]?.text, 1);
    await w.flush();
    await stream(w, call, '第二句。"}');
    call.resolve('{"action":"speak","replyTo":"c-a","text":"第一句。第二句。"}');
    await w.flush();
    assert.deepEqual(read.got, ['第一句。']);
    assert.deepEqual(w.logged('director.output-dropped'), []);
  } finally {
    await w.close();
  }
});

test('增量开口：最终输出不合法或与已送出的不一致时文本流以错误结束，算一次非法输出，不播过渡语', async () => {
  const w = await world({ config: { fallback: { lines: ['稍等，我想一想。'] } } });
  try {
    const finals: Array<[string[], string]> = [
      // 文本之后多了不认识的字段：schema 不通过。
      [
        ['{"action":"speak","replyTo":"c-0","text":"第一句。第二', '句。","mood":"开心"}'],
        '{"action":"speak","replyTo":"c-0","text":"第一句。第二句。","mood":"开心"}',
      ],
      // 重复的 text：整段解析取最后一个，与已送出的不同。
      [
        ['{"action":"speak","replyTo":"c-1","text":"说这个。","text":"其实说那个。"}'],
        '{"action":"speak","replyTo":"c-1","text":"说这个。","text":"其实说那个。"}',
      ],
      // 文本之后改了回应对象。
      [
        ['{"action":"speak","replyTo":"c-2","text":"你好。","replyTo":null}'],
        '{"action":"speak","replyTo":"c-2","text":"你好。","replyTo":null}',
      ],
      // 没写完就结束。
      [
        ['{"action":"speak","replyTo":"c-3","text":"半句'],
        '{"action":"speak","replyTo":"c-3","text":"半句',
      ],
    ];
    for (const [n, [deltas, final]] of finals.entries()) {
      await w.arrive(candidate({ id: `c-${n}` }));
      const call = w.call(n);
      await stream(w, call, ...deltas);
      assert.equal(w.spoken.length, n + 1, `第 ${n} 次开口`);
      const read = reader(w.spoken[n]?.text);
      await w.flush();
      call.resolve(final);
      await w.flush();
      assert.match(read.state.end ?? '', /最终校验/, `第 ${n} 次`);
    }
    assert.deepEqual(
      w.logged('director.output-dropped').map((f) => [f.kind, f.failures]),
      [
        ['invalid_output', 1],
        ['invalid_output', 2],
        ['invalid_output', 3],
        ['invalid_output', 4],
      ],
    );
    assert.equal(w.spoken.length, finals.length, '不播过渡语');
    // 连续失败满三次照常告警。
    assert.deepEqual(
      w.events('director.alarmed').map((e) => e.data),
      [{ cause: 'failures', count: 3, detail: 'invalid_output' }],
    );
  } finally {
    await w.close();
  }
});

test(`增量开口：文本超过 ${MAX_SPEAK_TEXT} 字时文本流以错误结束，最终算非法输出`, async () => {
  const w = await world();
  try {
    await w.arrive(candidate({ id: 'c-a' }));
    const call = w.call(0);
    await stream(w, call, '{"action":"speak","replyTo":"c-a","text":"');
    const read = reader(w.spoken[0]?.text);
    const long = '好'.repeat(MAX_SPEAK_TEXT);
    await stream(w, call, long);
    assert.equal(read.state.end, undefined, '恰好到上限不算超');
    await stream(w, call, '！', '还有"}');
    assert.match(read.state.end ?? '', /超过 200 字/);
    assert.equal(read.text(), long);
    call.resolve(`{"action":"speak","replyTo":"c-a","text":"${long}！还有"}`);
    await w.flush();
    assert.deepEqual(
      w.logged('director.output-dropped').map((f) => f.kind),
      ['invalid_output'],
    );
  } finally {
    await w.close();
  }
});

test('不提前开口：回应对象不在本次上下文、在文本之后、不是字符串；投票与沉默；都按整段解析', async () => {
  const w = await world({ vote: null });
  try {
    const cases: Array<{ deltas: string[]; final: string; kind?: string; spoken: number }> = [
      {
        deltas: ['{"action":"speak","replyTo":"c-nobody","text":"你好"}'],
        final: '{"action":"speak","replyTo":"c-nobody","text":"你好"}',
        kind: 'unknown_target',
        spoken: 0,
      },
      {
        deltas: ['{"action":"speak","text":"先说"', ',"replyTo":"c-1"}'],
        final: '{"action":"speak","text":"先说","replyTo":"c-1"}',
        spoken: 1,
      },
      {
        // 同一段增量里 text 之后才出现的 replyTo 不算。
        deltas: ['{"action":"speak","text":"先说","replyTo":"c-2"}'],
        final: '{"action":"speak","text":"先说","replyTo":"c-2"}',
        spoken: 1,
      },
      {
        deltas: ['{"action":"speak","replyTo":["c-3"],"text":"你好"}'],
        final: '{"action":"speak","replyTo":["c-3"],"text":"你好"}',
        kind: 'invalid_output',
        spoken: 0,
      },
      {
        deltas: [
          '{"action":"vote","replyTo":null,"text":null,"question":"玩什么",',
          '"options":["甲","乙"],"durationSec":30}',
        ],
        final:
          '{"action":"vote","replyTo":null,"text":null,"question":"玩什么","options":["甲","乙"],"durationSec":30}',
        spoken: 0,
      },
      {
        // 不合法的意图（投票带文本）也不开口。
        deltas: ['{"action":"vote","replyTo":null,"text":"说点什么"}'],
        final: '{"action":"vote","replyTo":null,"text":"说点什么"}',
        kind: 'invalid_output',
        spoken: 0,
      },
      {
        deltas: ['{"action":"silence","reason":"没什么要说的"}'],
        final: '{"action":"silence","reason":"没什么要说的"}',
        spoken: 0,
      },
      {
        deltas: ['好的：{"action":"speak","replyTo":null,"text":"你好"}'],
        final: '好的：{"action":"speak","replyTo":null,"text":"你好"}',
        kind: 'invalid_output',
        spoken: 0,
      },
    ];
    let spoken = 0;
    for (const [n, sample] of cases.entries()) {
      await w.arrive(candidate({ id: `c-${n}` }));
      const call = w.call(n);
      const dropped = w.logged('director.output-dropped').length;
      await stream(w, call, ...sample.deltas);
      assert.equal(w.spoken.length, spoken, `第 ${n} 次：流读完之前不发声`);
      call.resolve(sample.final);
      await w.flush();
      spoken += sample.spoken;
      assert.equal(w.spoken.length, spoken, `第 ${n} 次`);
      if (sample.spoken > 0) assert.equal(typeof w.spoken.at(-1)?.text, 'string', '整段交给发声');
      assert.deepEqual(
        w
          .logged('director.output-dropped')
          .slice(dropped)
          .map((f) => f.kind),
        sample.kind ? [sample.kind] : [],
        `第 ${n} 次`,
      );
    }
    assert.equal(w.voteRequests.length, 1);
  } finally {
    await w.close();
  }
});

test('取消：开口之前的闲聊调用仍可被取消，开口之后不再可以', async () => {
  const w = await world({ config: { idleMs: 1000 } });
  try {
    await w.advance(1000);
    const first = w.call(0);
    await stream(w, first, '{"action":"speak","replyTo":null,"te');
    await w.arrive(candidate({ id: 'c-a' }));
    assert.equal(first.signal.aborted, true, '还没开口：被新到的候选取消');
    assert.deepEqual(w.logged('director.cancelled'), [{ by: 'candidates' }]);
    // 取消之后客户端晚到的增量不理会。
    await stream(w, first, 'xt":"晚到的"}');
    assert.equal(w.spoken.length, 0);
    w.call(1).resolve('{"action":"silence","reason":"x"}');
    await w.flush();

    await w.advance(1000);
    const idle = w.call(2);
    await stream(w, idle, '{"action":"speak","replyTo":null,"text":"今天');
    assert.equal(w.spoken.length, 1);
    assert.deepEqual([w.spoken[0]?.source, w.spoken[0]?.preempt], ['chatter', 'immediate']);
    const read = reader(w.spoken[0]?.text);
    await w.arrive(candidate({ id: 'c-b' }));
    assert.equal(idle.signal.aborted, false, '开口之后不被取消');
    assert.equal(w.calls.length, 3, '新到的候选排队');
    await stream(w, idle, '天气不错。"}');
    idle.resolve('{"action":"speak","replyTo":null,"text":"今天天气不错。"}');
    await w.flush();
    assert.equal(read.state.end, 'done');
    assert.equal(read.text(), '今天天气不错。');
    assert.equal(w.calls.length, 4, '结束后处理排队的候选');
    assert.deepEqual(w.logged('director.cancelled'), [{ by: 'candidates' }]);
  } finally {
    await w.close();
  }
});

test('开口后出错、超时或停用：文本流以错误结束，按失败（停用按取消）记录，不播过渡语', async () => {
  const w = await world({
    config: { callTimeoutMs: 1000, fallback: { lines: ['稍等，我想一想。'] } },
  });
  try {
    await w.arrive(candidate({ id: 'c-a' }));
    await stream(w, w.call(0), '{"action":"speak","replyTo":"c-a","text":"第一句。第');
    const errored = reader(w.spoken[0]?.text);
    await w.flush();
    w.call(0).reject(new LlmError('network', '连接中断'));
    await w.flush();
    assert.equal(errored.state.end, '决策模型调用没有完成：network');
    assert.equal(errored.text(), '第一句。第');

    await w.arrive(candidate({ id: 'c-b' }));
    await stream(w, w.call(1), '{"action":"speak","replyTo":"c-b","text":"嗯');
    const timedOut = reader(w.spoken[1]?.text);
    await w.advance(1000);
    assert.ok(w.call(1).signal.reason instanceof DeadlineError);
    assert.equal(timedOut.state.end, '决策模型调用没有完成：timeout');
    assert.deepEqual(
      w.logged('director.output-dropped').map((f) => [f.kind, f.failures]),
      [
        ['network', 1],
        ['timeout', 2],
      ],
    );
    assert.equal(w.spoken.length, 2, '已经开口：不播过渡语');

    // 没开口的失败照常播过渡语（这一串里还没播过）。
    await w.arrive(candidate({ id: 'c-c' }));
    w.call(2).reject(new LlmError('server', '服务端出错'));
    await w.flush();
    assert.deepEqual(
      w.spoken.map((s) => (typeof s.text === 'string' ? s.text : '<流>')),
      ['<流>', '<流>', '稍等，我想一想。'],
    );

    await w.arrive(candidate({ id: 'c-d' }));
    await stream(w, w.call(3), '{"action":"speak","replyTo":"c-d","text":"再');
    const unloaded = reader(w.spoken[3]?.text);
    await w.kernel.disable('director');
    await w.flush();
    assert.equal(unloaded.state.end, '决策模型调用没有完成：cancelled');
    assert.deepEqual(w.logged('director.cancelled'), [{ by: 'unload' }]);
  } finally {
    await w.close();
  }
});

test('streamOutput 关闭：不扫描增量，流读完后整段解析，与之前相同', async () => {
  const w = await world({ telemetry: true, config: { streamOutput: false } });
  try {
    await w.arrive(candidate({ id: 'c-a' }));
    const call = w.call(0);
    await stream(w, call, '{"action":"speak","replyTo":"c-a","text":"你好', '呀！"}');
    assert.equal(w.spoken.length, 0);
    call.resolve('{"action":"speak","replyTo":"c-a","text":"你好呀！"}');
    await w.flush();
    assert.deepEqual(
      w.spoken.map((s) => [s.text, s.source]),
      [['你好呀！', 'danmaku-reply']],
    );
    const span = w.spans().find((s) => s.name === 'chat test-model');
    assert.equal(span?.attributes['bellis.director.streamed'], false);
    assert.deepEqual(span?.events, []);
  } finally {
    await w.close();
  }
});

test('使用反馈：开口的发言每次召回只回报一次，等整段校验与发言结果都有了再回报', async () => {
  const memories: RecalledMemory[] = [{ id: 'm1', text: '主播喜欢猫', kind: null, stance: null }];
  const feedback: Array<[string, string[]]> = [];
  let recalls = 0;
  const memory: Memory = {
    async recall() {
      recalls += 1;
      return { ok: true, recall: { recallId: `r${recalls}`, memories } };
    },
    feedback(recallId, used) {
      feedback.push([recallId, [...used]]);
    },
    check: async () => {},
    persona: undefined,
    currentPersona: async () => undefined,
    report: { ready: true, status: '就绪', pending: 0, written: 0, dropped: 0, tombstones: 0 },
  };
  const w = await world({ memory });
  try {
    // 合法：发言结束、观众听到了才回报用到的记忆。
    await w.arrive(candidate({ id: 'c-a' }));
    await stream(w, w.call(0), '{"action":"speak","replyTo":"c-a","text":"我也喜欢猫。"');
    reader(w.spoken[0]?.text);
    w.call(0).resolve('{"action":"speak","replyTo":"c-a","text":"我也喜欢猫。","memories":["m1"]}');
    await w.flush();
    assert.equal(feedback.length, 0, '等发言结果');
    w.finish[0]?.(outcome(w.spoken[0]?.id ?? '', '我也喜欢猫。'));
    await w.flush();
    assert.deepEqual(feedback, [['r1', ['m1']]]);

    // 发言在整段校验之前就结束了（例如过期）：校验通过后按发言结果回报一次。
    await w.arrive(candidate({ id: 'c-b' }));
    await stream(w, w.call(1), '{"action":"speak","replyTo":"c-b","text":"猫。"');
    w.finish[1]?.({ ...outcome(w.spoken[1]?.id ?? '', ''), end: 'expired' });
    await w.flush();
    assert.equal(feedback.length, 1);
    w.call(1).resolve('{"action":"speak","replyTo":"c-b","text":"猫。","memories":["m1"]}');
    await w.flush();
    assert.deepEqual(feedback.at(-1), ['r2', []]);

    // 最终不合法：立即回报空集，之后的发言结果不再回报。
    await w.arrive(candidate({ id: 'c-c' }));
    await stream(w, w.call(2), '{"action":"speak","replyTo":"c-c","text":"猫猫。"');
    reader(w.spoken[2]?.text);
    w.call(2).resolve('{"action":"speak","replyTo":"c-c","text":"猫猫。","memories":["m1"],"x":1}');
    await w.flush();
    assert.deepEqual(feedback.at(-1), ['r3', []]);
    w.finish[2]?.(outcome(w.spoken[2]?.id ?? '', '猫猫。'));
    await w.flush();
    assert.deepEqual(
      feedback.map(([id]) => id),
      ['r1', 'r2', 'r3'],
      '每次召回恰好一次',
    );
  } finally {
    await w.close();
  }
});
