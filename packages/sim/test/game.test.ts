import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameActionCommitted, GameDecisionPointOpened } from '@bellis/protocol';
import { checkHistory, gameScenario, simulate } from '../src/index.ts';

const options = { drainMs: 2_000 };

test('计时自选和余量线默认选择都经过有效目标与许可', async () => {
  for (const [kind, source, count, optionId] of [
    ['timed', 'director', 1, 'b'],
    ['timed-default', 'default', 0, 'a'],
  ] as const) {
    const { violations, history } = await simulate(gameScenario(kind, 21), options);
    assert.deepEqual(violations, []);
    const input = history.trace.filter((entry) => entry.kind === 'game.input');
    assert.equal(input.length, 1);
    const [first] = input;
    assert.ok(first);
    assert.equal(first.data.goalId, 'before-decision');
    assert.deepEqual(first.data.selection, { decisionPointId: 'd1', optionId, source });
    assert.equal(history.trace.filter((entry) => entry.kind === 'game.resolve').length, count);
  }
});

test('余量线选择最新候选排名第一的选项，初次观察和更新均可把 b 排第一', async () => {
  for (const [kind, ranks] of [
    ['timed-default', ['b']],
    ['timed-default-updated', ['a', 'b']],
  ] as const) {
    const scenario = gameScenario(kind, 21);
    assert.ok(scenario.game);
    if (kind === 'timed-default') {
      scenario.game.cues = scenario.game.cues.map((cue) =>
        cue.action === 'decision' ? { ...cue, rankedOptions: ['b', 'a'] } : cue,
      );
    }
    const { violations, history } = await simulate(scenario, options);
    assert.deepEqual(violations, []);
    const snapshots = history.events
      .filter((event) => event.type === 'decision_point.opened')
      .map((event) => (event.data as { payload: GameDecisionPointOpened }).payload);
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.candidates[0]?.optionId),
      ranks,
    );
    for (const snapshot of snapshots) {
      assert.equal(snapshot.decisionPointId, 'd1');
      assert.deepEqual(
        snapshot.options.map(({ id }) => id),
        ['a', 'b'],
      );
      assert.equal(snapshot.timing?.resolveByMs, 800);
    }
    const inputs = history.trace.filter((entry) => entry.kind === 'game.input');
    assert.deepEqual(
      inputs.map((entry) => entry.at),
      [800],
    );
    assert.deepEqual(inputs[0]?.data.selection, {
      decisionPointId: 'd1',
      optionId: 'b',
      source: 'default',
    });
    assert.ok(!history.trace.some((entry) => entry.kind === 'game.resolve'));
  }
});

test('缺少候选时没有默认选择，许可和原授权目标可继续推进', async () => {
  const scenario = gameScenario('timed-default', 21);
  assert.ok(scenario.game);
  scenario.game.cues.push(
    { atMs: 400, action: 'decision-candidates', id: 'd1', rankedOptions: [] },
    { atMs: 900, action: 'advance' },
  );
  const { violations, history } = await simulate(scenario, options);
  assert.deepEqual(violations, []);
  const initial = history.trace.find((entry) => entry.kind === 'fact.decision_point.opened');
  const unavailable = history.trace.find((entry) => entry.kind === 'game.candidates-unavailable');
  const permit = history.trace.find((entry) => entry.kind === 'game.lease');
  assert.ok(initial && unavailable && permit);
  assert.ok(initial.at < unavailable.at && unavailable.at < 800);
  const inputs = history.trace.filter((entry) => entry.kind === 'game.input');
  assert.deepEqual(
    inputs.map(({ at, data }) => [at, data.category, data.goalId, data.token]),
    [[900, 'advance', 'before-decision', permit.data.token]],
  );
});

test('把设备默认选择与持久动作一起改成非首位候选仍会报错', async () => {
  const { violations, history } = await simulate(gameScenario('timed-default', 21), options);
  assert.deepEqual(violations, []);
  const input = history.trace.find((entry) => entry.kind === 'game.input');
  const committed = history.trace.find((entry) => entry.kind === 'fact.action.committed');
  assert.ok(input && committed);
  const actual = committed.data.payload as GameActionCommitted;
  assert.ok(actual.selection);
  const selection = { ...actual.selection, optionId: 'b' };
  const payload = { ...actual, selection };
  const mutatedTrace = history.trace.map((entry) => {
    if (entry === input) return { ...entry, data: { ...entry.data, selection } };
    if (entry === committed) return { ...entry, data: { ...entry.data, payload } };
    return entry;
  });
  const mutatedEvents = history.events.map((event) =>
    event.seq === committed.data.factSeq
      ? { ...event, data: { ...(event.data as object), payload } }
      : event,
  );
  const expected = '设备默认选择不符合当前决策的首位候选';
  assert.ok(
    checkHistory({ ...history, trace: mutatedTrace, events: mutatedEvents }).some((reason) =>
      reason.includes(expected),
    ),
  );

  const noCandidates = [...history.trace];
  const at = input.at - 10;
  noCandidates.splice(
    noCandidates.findIndex((entry) => entry.at >= at),
    0,
    {
      seq: input.seq,
      at,
      kind: 'game.candidates-unavailable',
      data: { runtimeId: input.data.runtimeId, decisionPointId: actual.selection.decisionPointId },
    },
  );
  assert.ok(
    checkHistory({ ...history, trace: noCandidates }).some((reason) => reason.includes(expected)),
  );
});

test('语义命令须有双方一致的许可，设备每个计时实例至多选一次', async () => {
  const { violations, history } = await simulate(gameScenario('timed', 21), options);
  assert.deepEqual(violations, []);
  const lease = history.trace.find((entry) => entry.kind === 'game.lease');
  const goal = history.trace.find((entry) => entry.kind === 'game.goal');
  const resolve = history.trace.find((entry) => entry.kind === 'game.resolve');
  const point = history.trace.find((entry) => entry.kind === 'fact.decision_point.opened');
  const input = history.trace.find((entry) => entry.kind === 'game.input');
  assert.ok(lease && goal && resolve && point && input);

  const delayed = history.trace.filter((entry) => entry !== lease);
  delayed.splice(delayed.indexOf(goal) + 1, 0, { ...lease, at: goal.at + 10 });
  assert.ok(
    checkHistory({ ...history, trace: delayed }).some((reason) =>
      reason.includes('没有双方有效许可却送达游戏命令 ["game","goal.submit"'),
    ),
  );
  const revoked = [...history.trace];
  revoked.splice(resolve.seq, 0, {
    ...resolve,
    kind: 'game.host-lease',
    data: { token: null, expiresAtMs: null, ttlMs: null },
  });
  assert.ok(
    checkHistory({ ...history, trace: revoked }).some((reason) =>
      reason.includes('没有双方有效许可却送达游戏命令 ["game","decision.resolve"'),
    ),
  );

  const snapshot = point.data.payload as GameDecisionPointOpened;
  assert.ok(snapshot.timing);
  const at = snapshot.timing.resolveByMs;
  const duplicate = [...history.trace];
  duplicate.splice(
    duplicate.findIndex((entry) => entry.at > at),
    0,
    {
      ...input,
      at,
      data: {
        ...input.data,
        actionId: 'duplicate-default',
        atMs: at,
        selection: { decisionPointId: 'd1', optionId: 'a', source: 'default' },
      },
    },
  );
  assert.ok(
    checkHistory({ ...history, trace: duplicate }).some((reason) =>
      reason.includes('设备重复执行决策选择'),
    ),
  );
});

test('绑定投票保留选项映射并在核验选择后恢复原目标', async () => {
  const { violations, history } = await simulate(gameScenario('vote', 35), options);
  assert.deepEqual(violations, []);
  const trace = history.trace;
  const wait = trace.find(
    (entry) => entry.kind === 'game.goal' && entry.data.mode === 'waiting_vote',
  );
  const ended = trace.find((entry) => entry.kind === 'fact.vote.ended');
  const selected = trace.find((entry) => entry.kind === 'game.resolve');
  const inputs = trace.filter((entry) => entry.kind === 'game.input');
  assert.ok(wait && ended && selected);
  assert.ok(wait.seq < ended.seq && ended.seq < selected.seq);
  assert.equal(selected.data.source, 'vote');
  assert.equal(selected.data.optionId, 'b');
  assert.deepEqual(
    inputs.map((entry) => entry.data.goalId),
    [wait.data.goalId, 'before-decision'],
  );

  const opened = trace.find((entry) => entry.kind === 'fact.vote.started');
  const [selection] = inputs;
  assert.ok(opened && selection);
  const early = trace.filter((entry) => entry !== selection);
  early.splice(opened.seq + 1, 0, {
    ...selection,
    at: opened.at,
    data: { ...selection.data, atMs: opened.at },
  });
  assert.ok(
    checkHistory({ ...history, trace: early }).some((reason) =>
      reason.includes('绑定投票结束前设备已执行选择'),
    ),
  );

  const decision = history.events.find((event) => event.type === 'decision_point.opened');
  const last = history.events.at(-1);
  const observed = trace.find((entry) => entry.kind === 'fact.decision_point.opened');
  const final = trace.at(-1);
  assert.ok(decision && last && observed && final);
  // 同一 Runtime、同一实例的未来事实也不能作为这次开场的来源。
  const future = { ...decision, seq: last.seq + 1, recordedAt: last.recordedAt + 1 };
  const futureTrace = [
    ...trace,
    {
      ...observed,
      seq: trace.length,
      at: final.at + 1,
      data: { ...observed.data, factSeq: future.seq },
    },
  ];
  for (const inputs of [[], ['game:999999'], [`game:${future.seq}`]]) {
    const events = history.events.map((event) => {
      if (event.type !== 'intent.authorized') return event;
      const data = event.data as { key: string; source: { inputs: string[] } };
      if (!data.key.endsWith(':opening#0')) return event;
      return { ...event, data: { ...data, source: { ...data.source, inputs } } };
    });
    events.push(future);
    assert.ok(
      checkHistory({ ...history, trace: futureTrace, events }).some((reason) =>
        reason.includes('游戏投票开场没有关联持久决策点'),
      ),
    );
  }
});

test('有效许可下漏掉语义目标的模拟选择会被独立不变量检出', async () => {
  const { violations, history } = await simulate(gameScenario('timed', 9), options);
  assert.deepEqual(violations, []);
  const lease = history.trace.find((entry) => entry.kind === 'game.lease');
  const input = history.trace.find((entry) => entry.kind === 'game.input');
  assert.ok(lease && input);
  const trace = [...history.trace];
  trace.splice(lease.seq + 1, 0, { ...input, at: lease.at });
  assert.ok(
    checkHistory({ ...history, trace }).some((reason) => reason.includes('没有有效目标却执行')),
  );
});

for (const [kind, reason] of [
  ['takeover', 'takeover'],
  ['estop', 'lease_revoked'],
  ['disconnect', 'lease_source_lost'],
  ['expire', 'lease_expired'],
] as const) {
  test(`持有模拟输入时 ${kind} 释放账目并拒绝后续目标`, async () => {
    const { violations, history } = await simulate(gameScenario(kind, 8), options);
    assert.deepEqual(violations, []);
    const trace = history.trace;
    const inputs = trace.filter((entry) => entry.kind === 'game.input');
    const release = trace.find(
      (entry) => entry.kind === 'game.device-release' && entry.data.reason === reason,
    );
    assert.equal(inputs.length, 1);
    assert.ok(release && inputs[0] && inputs[0].seq < release.seq);
    assert.deepEqual(release.data.held, ['advance']);
    assert.deepEqual(release.data.remaining, []);
    assert.equal(release.data.verification, 'verified');
    assert.ok(
      trace.some(
        (entry) =>
          entry.kind === 'game.goal-result' &&
          entry.data.id === 'after-stop' &&
          entry.data.ok === false,
      ),
    );
  });
}

test('没有任何释放报告也能检出模拟许可到期后仍持有输入', async () => {
  const { violations, history } = await simulate(gameScenario('expire', 8), options);
  assert.deepEqual(violations, []);
  const trace = history.trace.filter(
    ({ kind }) => kind !== 'game.device-release' && kind !== 'fact.input.released',
  );
  const events = history.events.filter(({ type }) => type !== 'input.released');
  assert.ok(
    checkHistory({ ...history, trace, events }).includes(
      '许可到期后超过许可时长仍有模拟输入未释放',
    ),
  );
});

test('坏结局解说完成后才恢复，卡住只留下操作员通知', async () => {
  const ending = await simulate(gameScenario('bad-ending', 15), options);
  assert.deepEqual(ending.violations, []);
  const completed = ending.history.trace.find(
    (entry) =>
      entry.kind === 'fact.utterance' &&
      entry.data.source === 'game-reaction' &&
      entry.data.end === 'complete',
  );
  const goal = ending.history.trace.find((entry) => entry.kind === 'game.goal');
  assert.ok(completed && goal && completed.seq < goal.seq);
  assert.ok(ending.history.trace.some((entry) => entry.kind === 'game.input'));

  const stuck = await simulate(gameScenario('stuck', 15), options);
  assert.deepEqual(stuck.violations, []);
  assert.ok(
    stuck.history.events.some((event) => event.type === 'director.game-assistance-requested'),
  );
  assert.ok(
    !stuck.history.trace.some((entry) => entry.kind === 'game.input' || entry.kind === 'game.goal'),
  );
});

test('等待决定和持有输入中重启都需要新目标', async () => {
  const waiting = await simulate(gameScenario('restart-waiting', 7), options);
  assert.deepEqual(waiting.violations, []);
  assert.equal(waiting.restarts, 1);
  const lost = waiting.history.trace.find((entry) => entry.kind === 'game.host-lost');
  const resolve = waiting.history.trace.filter((entry) => entry.kind === 'game.resolve');
  assert.equal(lost?.data.decisionPointId, 'd1');
  assert.equal(resolve.length, 1);
  assert.ok(lost && resolve[0] && resolve[0].seq > lost.seq);
  assert.equal(
    waiting.history.trace.find((entry) => entry.kind === 'game.input')?.data.goalId,
    'after-restart',
  );

  const active = await simulate(gameScenario('restart-active', 7), options);
  assert.deepEqual(active.violations, []);
  assert.equal(active.restarts, 1);
  const inputs = active.history.trace.filter((entry) => entry.kind === 'game.input');
  assert.deepEqual(
    inputs.map((entry) => entry.data.goalId),
    ['first', 'after-restart'],
  );
  assert.ok(Number(inputs[1]?.data.token) > Number(inputs[0]?.data.token));
  assert.ok(
    active.history.trace.some(
      (entry) =>
        entry.kind === 'game.device-release' &&
        entry.data.reason === 'lease_source_lost' &&
        (entry.data.held as string[]).includes('advance'),
    ),
  );
});

test('游戏目标送达后、应答前宿主崩溃，恢复留下未知意图并禁止重放', async () => {
  const { violations, history, restarts } = await simulate(gameScenario('unknown', 91), options);
  assert.deepEqual(violations, []);
  assert.equal(restarts, 1);
  const orphaned = history.events.find((event) => event.type === 'intent.orphaned');
  assert.ok(orphaned);
  const { id } = orphaned.data as { id: number };
  const persistence = history.events.filter((event) => (event.data as { id?: number }).id === id);
  assert.deepEqual(
    persistence.map((event) => event.type),
    ['intent.authorized', 'intent.started', 'intent.orphaned', 'intent.reconciled'],
  );
  assert.equal((persistence.at(-1)?.data as { by: string } | undefined)?.by, 'operator');
  const heldReply = history.trace.find((entry) => entry.kind === 'game.goal-reply-held');
  const restart = history.trace.find(
    (entry) => entry.kind === 'world.start' && entry.data.restarts === 1,
  );
  assert.ok(heldReply && restart && heldReply.at < restart.at);
  assert.ok(orphaned.seq <= Number(restart.data.factSeq));
  assert.deepEqual(
    history.trace.filter((entry) => entry.kind === 'game.goal').map((entry) => entry.data.goalId),
    ['uncertain', 'after-resolution'],
  );
  assert.ok(history.trace.some((entry) => entry.kind === 'operator.preflight-refused'));
  const isolated = history.trace.filter(
    (entry) =>
      entry.kind === 'game.goal-result' && String(entry.data.reason).includes('游戏目标已隔离'),
  );
  assert.deepEqual(
    isolated.map((entry) => entry.data.id),
    ['isolated', 'uncertain'],
  );
  const first = history.trace.find((entry) => entry.kind === 'game.goal');
  const retry = isolated.at(-1);
  assert.ok(first && retry);
  const replay = [...history.trace];
  replay.splice(retry.seq, 0, { ...first, at: retry.at });
  assert.ok(
    checkHistory({ ...history, trace: replay }).some((reason) =>
      reason.includes('游戏命令缺少本次启动中未使用的执行授权'),
    ),
  );
});

test('解说只在已确认动作之后请求，解除失败时按绝对 hold 到期恢复', async () => {
  const { violations, history } = await simulate(gameScenario('pacing', 27), options);
  assert.deepEqual(violations, []);
  const trace = history.trace;
  const comment = trace.filter(
    (entry) => entry.kind === 'speech.requested' && entry.data.id === 'game:sim-runtime:a1:comment',
  );
  const committed = trace.find((entry) => entry.kind === 'fact.action.committed');
  const hold = trace.find((entry) => entry.kind === 'game.hold');
  const ended = trace.find((entry) => entry.kind === 'game.hold-end');
  const inputs = trace.filter((entry) => entry.kind === 'game.input');
  assert.equal(comment.length, 1);
  assert.ok(comment[0] && committed && committed.seq < comment[0].seq);
  assert.ok(history.events.some((event) => event.type === 'director.game-decision-failed'));
  assert.ok(history.events.some((event) => event.type === 'pacing.unconfirmed'));
  assert.ok(hold && ended);
  assert.equal(ended.data.reason, 'expired');
  assert.equal(ended.at, hold.data.expiresAtMs);
  assert.ok(trace.some((entry) => entry.kind === 'game.advance-held'));
  assert.equal(inputs.length, 2);
  assert.equal(inputs[1]?.at, ended.at);
  const tooEarly = [comment[0], ...trace];
  assert.ok(
    checkHistory({ ...history, trace: tooEarly }).some((reason) =>
      reason.includes('已确认动作事实之前请求了解说'),
    ),
  );

  const wrongGoal = { ...(committed.data.payload as GameActionCommitted), goalId: 'unrelated' };
  const wrongTrace = trace.map((entry) =>
    entry === committed ? { ...entry, data: { ...entry.data, payload: wrongGoal } } : entry,
  );
  const wrongEvents = history.events.map((event) =>
    event.seq === committed.data.factSeq
      ? { ...event, data: { ...(event.data as object), payload: wrongGoal } }
      : event,
  );
  assert.ok(
    checkHistory({ ...history, trace: wrongTrace, events: wrongEvents }).some((reason) =>
      reason.includes('已确认动作与先前设备输入不符'),
    ),
  );

  const resumed = inputs[1];
  assert.ok(resumed);
  const resumedFact = trace.find(
    (entry) =>
      entry.kind === 'fact.action.committed' &&
      (entry.data.payload as GameActionCommitted).actionId === resumed.data.actionId,
  );
  assert.ok(resumedFact);
  const stalled = trace.filter(
    (entry) => entry !== ended && entry !== resumed && entry !== resumedFact,
  );
  const stalledEvents = history.events.filter((event) => event.seq !== resumedFact.data.factSeq);
  const missed = checkHistory({ ...history, trace: stalled, events: stalledEvents });
  assert.ok(missed.some((reason) => reason.includes('模拟 hold 已过绝对到期时刻仍无解除证据')));
  assert.ok(missed.some((reason) => reason.includes('仍未恢复等待 hold 解除的推进')));
});

test('普通局面的 idle 调用建立首个目标，到期后须收到新的明确授权', async () => {
  const { violations, history } = await simulate(gameScenario('idle-goals', 13), options);
  assert.deepEqual(violations, []);
  const trace = history.trace;
  const goals = trace.filter((entry) => entry.kind === 'game.goal');
  const actions = trace.filter((entry) => entry.kind === 'game.input');
  const denied = trace.filter((entry) => entry.kind === 'game.advance-denied');
  const firstCall = trace.find((entry) => entry.kind === 'llm.request');
  assert.equal(firstCall?.at, 400);
  assert.deepEqual(firstCall?.data.candidates, []);
  assert.equal(goals.length, 2);
  assert.ok(goals[0] && goals[1] && firstCall && firstCall.seq < goals[0].seq);
  assert.deepEqual(
    actions.map((entry) => entry.data.goalId),
    goals.map((entry) => entry.data.goalId),
  );
  assert.ok(denied.some((entry) => entry.at < (goals[0]?.at ?? 0)));
  assert.ok(
    denied.some(
      (entry) => entry.at >= Number(goals[0]?.data.expiresAtMs) && entry.at < (goals[1]?.at ?? 0),
    ),
  );
  assert.ok(
    !trace.some((entry) => entry.kind === 'fact.vote.started' || entry.kind === 'game.resolve'),
  );
});

test('相同场景与种子的游戏事件、追踪和遥测完全一致', async () => {
  for (const kind of ['restart-waiting', 'unknown', 'expire', 'vote', 'pacing'] as const) {
    const scenario = gameScenario(kind, 2026, 40);
    const first = await simulate(scenario, options);
    const second = await simulate(scenario, options);
    assert.deepEqual(first.violations, [], kind);
    assert.deepEqual(second, first, kind);
  }
});
