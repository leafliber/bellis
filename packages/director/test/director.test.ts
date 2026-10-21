import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INTENT_OUTPUT, LlmError, UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from '../src/index.ts';
import { candidate, silence, speak, world } from './helpers.ts';

test('新一批候选到达即调用模型；在途时到达的候选排队，结束后合并成一次调用', async () => {
  const w = await world();
  try {
    const first = candidate({ id: 'c-a', text: '主播你好' });
    await w.arrive(first);
    assert.equal(w.calls.length, 1);
    const call = w.call(0);
    assert.deepEqual(call.request.context.triggers, ['candidates']);
    assert.deepEqual(
      call.request.context.candidates.map((c) => c.id),
      ['c-a'],
    );
    assert.equal(call.request.output, INTENT_OUTPUT);
    assert.equal(call.request.messages.length, 2);

    await w.arrive(candidate({ id: 'c-b' }));
    await w.arrive(candidate({ id: 'c-c' }));
    assert.equal(w.calls.length, 1, '同时只有一个在途调用');
    assert.equal(call.signal.aborted, false, '带候选的调用不被新候选取消');

    call.resolve(speak('你好呀！', 'c-a'));
    await w.flush();
    assert.equal(w.spoken.length, 1);
    assert.equal(w.spoken[0]?.source, 'danmaku-reply');
    assert.deepEqual(w.spoken[0]?.inputs, first.sources);
    assert.equal(w.calls.length, 2, '排队的两批合并成一次调用');
    assert.deepEqual(
      w.call(1).request.context.candidates.map((c) => c.id),
      ['c-b', 'c-c'],
    );
    w.call(1).resolve(silence);
    await w.flush();
    assert.equal(w.calls.length, 2);
    assert.deepEqual(w.logged('director.output-dropped'), []);
  } finally {
    await w.close();
  }
});

test('在途的闲聊调用被新到的候选取消并立即重来；取消不算失败，晚到的输出不播', async () => {
  const w = await world({ config: { idleMs: 1000 } });
  try {
    await w.advance(1000);
    assert.equal(w.calls.length, 1);
    const idle = w.call(0);
    assert.deepEqual(idle.request.context.triggers, ['idle']);
    assert.deepEqual(idle.request.context.candidates, []);

    await w.arrive(candidate({ id: 'c-a' }));
    assert.equal(idle.signal.aborted, true, '闲聊调用被取消');
    assert.equal(w.calls.length, 2, '取消后立即重来');
    assert.deepEqual(w.call(1).request.context.triggers, ['candidates']);
    assert.deepEqual(w.logged('director.cancelled'), [{ by: 'candidates' }]);

    // 客户端没理会中止信号、晚到的输出：不播。
    idle.resolve(speak('今天天气不错。'));
    w.call(1).resolve(speak('欢迎！', 'c-a'));
    await w.flush();
    assert.deepEqual(
      w.spoken.map((s) => s.text),
      ['欢迎！'],
    );
    assert.deepEqual(w.logged('director.output-dropped'), []);
  } finally {
    await w.close();
  }
});

test('在途时冷场到期不另排；候选到达时在途的不是闲聊就排队', async () => {
  const w = await world({ config: { idleMs: 1000 } });
  try {
    await w.arrive(candidate({ id: 'c-a' }));
    assert.equal(w.calls.length, 1);
    await w.advance(1500);
    assert.equal(w.calls.length, 1, '在途时冷场到期不另排');
    await w.arrive(candidate({ id: 'c-b' }));
    assert.equal(w.calls.length, 1);
    assert.equal(w.call(0).signal.aborted, false);
    w.call(0).resolve(silence);
    await w.flush();
    assert.equal(w.calls.length, 2);
    assert.deepEqual(w.call(1).request.context.triggers, ['candidates']);
    w.call(1).resolve(silence);
    await w.flush();
    // 结束后重新计冷场。
    await w.advance(990);
    assert.equal(w.calls.length, 2);
    await w.advance(20);
    assert.equal(w.calls.length, 3);
    assert.deepEqual(w.call(2).request.context.triggers, ['idle']);
  } finally {
    await w.close();
  }
});

test('投票结束触发决策：刚结束的投票与进行中的投票只出现在不可信数据区', async () => {
  const w = await world({
    vote: {
      voteId: 'v-1',
      question: '下一把玩什么',
      options: ['魔女审判', '逆转裁判'],
      counts: [3, 1],
      valid: 4,
      phase: 'open',
      durationMs: 30_000,
      remainingMs: 12_300,
      decisionPoint: null,
      gap: false,
    },
  });
  try {
    await w.voteEnded({
      voteId: 'v-0',
      question: '要不要唱歌',
      options: ['要', '不要'],
      counts: [5, 2],
      valid: 7,
      outcome: 'winner',
      winners: [1],
      decisionPoint: null,
    });
    assert.equal(w.calls.length, 1);
    const { context, messages } = w.call(0).request;
    assert.deepEqual(context.triggers, ['vote-ended']);
    assert.deepEqual(context.endedVote, {
      question: '要不要唱歌',
      options: [
        { number: 1, text: '要', votes: 5 },
        { number: 2, text: '不要', votes: 2 },
      ],
      outcome: 'winner',
      winners: [1],
    });
    assert.deepEqual(context.vote, {
      phase: 'open',
      question: '下一把玩什么',
      options: [
        { number: 1, text: '魔女审判', votes: 3 },
        { number: 2, text: '逆转裁判', votes: 1 },
      ],
      remainingSec: 13,
    });
    const system = messages[0]?.content ?? '';
    const user = messages[1]?.content ?? '';
    const inside = user.slice(user.indexOf(UNTRUSTED_OPEN), user.indexOf(UNTRUSTED_CLOSE));
    for (const text of ['要不要唱歌', '下一把玩什么', '魔女审判', '逆转裁判']) {
      assert.ok(!system.includes(text), text);
      assert.ok(inside.includes(text), text);
      assert.equal(user.indexOf(text), user.lastIndexOf(text), `${text} 只出现一次`);
    }
    w.call(0).resolve(silence);
    await w.flush();

    // 在途的闲聊调用遇到投票结束：取消并重来。
    const v = await world({ config: { idleMs: 500 } });
    try {
      await v.advance(500);
      assert.equal(v.calls.length, 1);
      await v.voteEnded({
        voteId: 'v-2',
        question: '题目',
        options: ['甲', '乙'],
        counts: [0, 0],
        valid: 0,
        outcome: 'none',
        winners: [],
        decisionPoint: null,
      });
      assert.equal(v.call(0).signal.aborted, true);
      assert.equal(v.calls.length, 2);
      assert.deepEqual(v.call(1).request.context.triggers, ['vote-ended']);
    } finally {
      await v.close();
    }
  } finally {
    await w.close();
  }
});

test('发起投票交给投票插件；进行中没有投票时上下文里为 null', async () => {
  const w = await world({ vote: null });
  try {
    await w.arrive(candidate({ id: 'c-a' }));
    assert.equal(w.call(0).request.context.vote, null);
    w.call(0).resolve(
      JSON.stringify({
        action: 'vote',
        question: '玩什么',
        options: ['甲', '乙'],
        durationSec: 30,
        replyTo: null,
        text: null,
        reason: null,
        decisionPoint: null,
      }),
    );
    await w.flush();
    assert.equal(w.voteRequests.length, 1);
    assert.deepEqual((w.voteRequests[0] as { options: string[]; untrusted: boolean }).options, [
      '甲',
      '乙',
    ]);
    assert.equal((w.voteRequests[0] as { untrusted: boolean }).untrusted, true);
  } finally {
    await w.close();
  }
});

test('超时与出错：放弃本次时机，有观众在等时播一句过渡语；连续失败告警并请求安全核降级', async () => {
  const w = await world({
    config: {
      callTimeoutMs: 1000,
      alarmAfter: 3,
      fallback: { lines: ['稍等，我想一想。', '嗯……'], ttlMs: 4000 },
    },
  });
  try {
    await w.arrive(candidate({ id: 'c-a' }));
    await w.advance(1000);
    assert.equal(w.call(0).signal.aborted, true, '超时即取消调用');
    assert.deepEqual(
      w.logged('director.output-dropped').map((f) => f.kind),
      ['timeout'],
    );
    assert.equal(w.spoken.length, 1);
    assert.deepEqual(
      {
        text: w.spoken[0]?.text,
        source: w.spoken[0]?.source,
        untrusted: w.spoken[0]?.untrusted,
        inputs: w.spoken[0]?.inputs,
        expiresAt: w.spoken[0]?.expiresAt,
      },
      {
        text: '稍等，我想一想。',
        source: 'chatter',
        untrusted: false,
        inputs: [],
        expiresAt: 5000,
      },
    );

    // 同一串连续失败里不再播过渡语；非法输出也不播。
    await w.arrive(candidate({ id: 'c-b' }));
    w.call(1).reject(new LlmError('server', '服务端出错：HTTP 503', { status: 503 }));
    await w.flush();
    assert.equal(w.spoken.length, 1);
    assert.equal(w.safety.mode, 'M0');
    await w.arrive(candidate({ id: 'c-c' }));
    w.call(2).resolve('不是 JSON');
    await w.flush();
    assert.deepEqual(
      w.logged('director.output-dropped').map((f) => [f.kind, f.failures]),
      [
        ['timeout', 1],
        ['server', 2],
        ['invalid_output', 3],
      ],
    );
    // 第三次：告警（进近期告警的事实）并请求降级；M0 降级即安全停止。
    assert.deepEqual(
      w.events('director.alarmed').map((e) => e.data),
      [{ cause: 'failures', count: 3, detail: 'invalid_output' }],
    );
    const requested = w
      .events('safety.downgrade-requested')
      .map((e) => e.data as { holder: string; reason: string; mode: string });
    assert.equal(requested.length, 1);
    assert.match(requested[0]?.holder ?? '', /^director#/);
    assert.equal(requested[0]?.reason, '决策模型连续失败 3 次（最近一次：invalid_output）');
    assert.equal(requested[0]?.mode, 'M0');
    assert.equal(w.safety.mode, 'safe-stop');

    // 成功一次即清零；新的一串失败再播下一句过渡语。
    await w.arrive(candidate({ id: 'c-d' }));
    w.call(3).resolve(silence);
    await w.flush();
    await w.arrive(candidate({ id: 'c-e' }));
    w.call(4).reject(new LlmError('rate_limit', '限流：HTTP 429', { status: 429 }));
    await w.flush();
    assert.deepEqual(
      w.spoken.map((s) => s.text),
      ['稍等，我想一想。', '嗯……'],
    );
    assert.deepEqual(w.logged('director.output-dropped').at(-1), {
      kind: 'rate_limit',
      reason: '限流：HTTP 429',
      failures: 1,
    });
  } finally {
    await w.close();
  }
});

test('没有观众在等（闲聊）时失败不播过渡语；回应对象不在上下文中算失败', async () => {
  const w = await world({
    config: { idleMs: 500, callTimeoutMs: 300, fallback: { lines: ['稍等。'] } },
  });
  try {
    await w.advance(500);
    await w.advance(300);
    assert.equal(w.call(0).signal.aborted, true);
    assert.equal(w.spoken.length, 0);
    await w.arrive(candidate({ id: 'c-a' }));
    w.call(1).resolve(speak('你好', 'c-nobody'));
    await w.flush();
    assert.deepEqual(
      w.logged('director.output-dropped').map((f) => [f.kind, f.reason]),
      [
        ['timeout', '决策模型调用 未在 300ms 内完成'],
        ['unknown_target', '回应对象 c-nobody 不在本次上下文中'],
      ],
    );
    assert.equal(w.spoken.length, 0);
  } finally {
    await w.close();
  }
});

test('严格 schema 形状的输出（不用的字段为 null）照常解析', async () => {
  const w = await world();
  try {
    await w.arrive(candidate({ id: 'c-a' }));
    w.call(0).resolve(
      JSON.stringify({
        action: 'speak',
        replyTo: 'c-a',
        text: '收到！',
        question: null,
        options: null,
        durationSec: null,
        decisionPoint: null,
        reason: null,
      }),
    );
    await w.flush();
    assert.deepEqual(
      w.spoken.map((s) => [s.text, s.source]),
      [['收到！', 'danmaku-reply']],
    );
  } finally {
    await w.close();
  }
});

test('人设漂移信号：重复、出戏用语、格式异常记日志与 span；连续命中告警并请求降级', async () => {
  const w = await world({
    heard: ['欢迎来到直播间，今天我们玩魔女审判。'],
    telemetry: true,
  });
  try {
    const say = async (n: number, text: string) => {
      await w.arrive(candidate({ id: `c-${n}` }));
      w.call(n).resolve(speak(text, `c-${n}`));
      await w.flush();
    };
    await say(0, '欢迎来到直播间！今天我们玩魔女审判');
    await say(1, '作为一个 AI 语言模型，我不能评价。');
    await say(2, '谢谢大家！');
    await say(3, '**重点**来了');
    await say(4, '谢谢大家！');
    assert.deepEqual(
      w.logged('director.drift').map((f) => [f.signals, f.streak]),
      [
        [['repeat'], 1],
        [['phrase'], 2],
        [['format'], 1],
        [['repeat'], 2],
      ],
    );
    assert.equal(w.safety.mode, 'M0', '连续命中不足三次，不告警');
    await say(5, '[链接] https://example.com');
    assert.deepEqual(
      w.events('director.alarmed').map((e) => e.data),
      [{ cause: 'drift', count: 3, detail: 'format' }],
    );
    assert.equal(w.safety.mode, 'safe-stop');
    // 漂移只是信号：命中的输出照常交给发声（由审核与操作员把关）。
    assert.equal(w.spoken.length, 6);
    await w.flush();
    const drift = w
      .spans()
      .filter((s) => s.name === 'chat test-model')
      .map((s) => s.attributes['bellis.director.drift'] ?? null);
    assert.deepEqual(drift, ['repeat', 'phrase', null, 'format', 'repeat', 'format']);
  } finally {
    await w.close();
  }
});

test('遥测：首块与第一个正文块的耗时；取消之后报来的不记；不记上下文与输出', async () => {
  const w = await world({ telemetry: true, config: { idleMs: 1000 } });
  try {
    await w.arrive(candidate({ id: 'c-a', text: '你好呀主播' }));
    const call = w.call(0);
    await w.advance(40);
    call.options?.onFirstChunk?.();
    await w.advance(60);
    call.options?.onFirstOutput?.();
    call.options?.onUsage?.({ inputTokens: 300, outputTokens: 20, reasoningOutputTokens: 12 });
    call.resolve(speak('谢谢！', 'c-a'));
    await w.flush();
    // 闲聊调用被取消后再报的首块与正文块不记。
    await w.advance(1000);
    const idle = w.call(1);
    await w.arrive(candidate({ id: 'c-b' }));
    idle.options?.onFirstChunk?.();
    idle.options?.onFirstOutput?.();
    w.call(2).resolve(silence);
    await w.flush();
    const spans = w.spans().filter((s) => s.name === 'chat test-model');
    assert.deepEqual(
      spans.map((s) => [
        s.attributes['bellis.director.trigger'],
        s.attributes['error.type'] ?? null,
      ]),
      [
        ['candidates', null],
        ['idle', 'cancelled'],
        ['candidates', null],
      ],
    );
    assert.equal(spans[0]?.attributes['gen_ai.usage.reasoning.output_tokens'], 12);
    assert.deepEqual(w.metric('gen_ai.client.inference.time_to_first_chunk'), [0.04]);
    assert.deepEqual(w.metric('bellis.llm.time_to_first_output'), [0.1]);
    const raw = JSON.stringify(w.spans(), (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    assert.ok(!raw.includes('你好呀主播') && !raw.includes('谢谢！'));
  } finally {
    await w.close();
  }
});

test('停用时取消在途调用', async () => {
  const w = await world();
  try {
    await w.arrive(candidate({ id: 'c-a' }));
    const call = w.call(0);
    await w.kernel.disable('director');
    assert.equal(call.signal.aborted, true);
    call.resolve(speak('还在吗', 'c-a'));
    await w.flush();
    assert.equal(w.spoken.length, 0);
  } finally {
    await w.close();
  }
});
