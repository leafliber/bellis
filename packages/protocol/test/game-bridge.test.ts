import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  checkGameBridgeMessage,
  checkGameBridgeParams,
  checkGameBridgeSuccess,
  GAME_BRIDGE_SEMANTIC_V2,
  type GameBridgeSender,
  type GameDecisionPointOpened,
  type GameMainDescription,
  type GameSituationObserved,
  GameBridgeMethod as Method,
  parseGameBridgeJson,
  GameBridgeRole as Role,
  readGameBridgeMajor,
} from '../src/index.ts';

interface WireFixture {
  name: string;
  sender: GameBridgeSender;
  message?: unknown;
  rawJson?: string;
  valid: boolean;
  responseTo?: string;
}

const controlFixtures = JSON.parse(
  readFileSync(new URL('./fixtures/game-control.json', import.meta.url), 'utf8'),
) as WireFixture[];

test('语义 v2 夹具独立于旧语义和控制角色', () => {
  const fixtures = JSON.parse(
    readFileSync(new URL('./fixtures/game-main-v2.json', import.meta.url), 'utf8'),
  ) as WireFixture[];
  const major = GAME_BRIDGE_SEMANTIC_V2;
  for (const { name, sender, message: fixture, rawJson, valid, responseTo } of fixtures) {
    assert.notEqual(rawJson !== undefined, fixture !== undefined, name);
    let message: unknown;
    try {
      message = parseGameBridgeJson(rawJson ?? JSON.stringify(fixture), major);
    } catch (error) {
      assert.ok(error instanceof SyntaxError, name);
      assert.equal(valid, false, name);
      continue;
    }
    const checked = responseTo
      ? sender === 'runtime' && checkGameBridgeSuccess(Role.Main, responseTo, message, major)
      : checkGameBridgeMessage(Role.Main, sender, message, major);
    assert.equal(checked, valid, name);
    assert.equal(checkGameBridgeMessage(Role.Core, sender, message, major), false, name);
    assert.equal(
      responseTo
        ? checkGameBridgeSuccess(Role.Main, responseTo, message, 3)
        : checkGameBridgeMessage(Role.Main, sender, message, 3),
      false,
      name,
    );
  }
  assert.equal(checkGameBridgeParams(Role.Main, 'bellis', Method.TaskOpen, {}), false);
});

test('控制连接夹具按角色、方向和 JSON-RPC 类型校验', () => {
  for (const { name, sender, message: fixture, rawJson, valid, responseTo } of controlFixtures) {
    assert.notEqual(rawJson !== undefined, fixture !== undefined, name);
    let message: unknown;
    try {
      // rawJson 直接交给线上解码，保留会被 JS 归一化的数字写法。
      message = parseGameBridgeJson(rawJson ?? JSON.stringify(fixture));
    } catch (error) {
      assert.ok(error instanceof SyntaxError, name);
      assert.equal(valid, false, name);
      continue;
    }
    const checked = responseTo
      ? sender === 'runtime' && checkGameBridgeSuccess(Role.Core, responseTo, message)
      : checkGameBridgeMessage(Role.Core, sender, message);
    assert.equal(checked, valid, name);
  }
  assert.equal(
    checkGameBridgeParams(Role.Main, 'bellis', Method.LeaseRenew, { token: 1, expiresAtMs: 900 }),
    false,
  );
});

const mainDescription = {
  major: 1,
  runtimeId: 'run-02',
  nowMs: 144_000,
  adapter: {
    id: 'synthetic-game',
    version: '0.1.0',
    screenTypes: [{ name: '调查', base: '菜单' }],
  },
  prerequisites: [{ id: 'test-confirmed', text: '允许受监督验收', confirmed: false }],
} satisfies GameMainDescription;

test('先读 game.describe 主版本，再校验当前版本的应答正文', () => {
  const sameShape = { jsonrpc: '2.0', id: 1, result: { ...mainDescription, major: 2 } };
  assert.equal(readGameBridgeMajor(sameShape.result), 2);
  assert.equal(checkGameBridgeSuccess(Role.Main, Method.Describe, sameShape), false);

  const futureWire =
    '{"jsonrpc":"2.0","id":1,"result":{"major":2,"nowMs":1.5,"newField":{"id":7e0}}}';
  const future = parseGameBridgeJson(futureWire) as { result: unknown };
  assert.equal(readGameBridgeMajor(future.result), 2);
  assert.equal(checkGameBridgeSuccess(Role.Core, Method.Describe, future), false);
  assert.throws(
    () => parseGameBridgeJson(futureWire.replace('"major":2', '"major":2.0')),
    SyntaxError,
  );
  assert.throws(() => parseGameBridgeJson(futureWire.replace('"id":1', '"id":1e0')), SyntaxError);

  const current = {
    jsonrpc: '2.0',
    id: 1,
    result: { major: 1, runtimeId: 'run-02', nowMs: 144_000, newField: true },
  };
  assert.equal(readGameBridgeMajor(current.result), 1);
  assert.equal(checkGameBridgeSuccess(Role.Core, Method.Describe, current), false);
  assert.equal(readGameBridgeMajor({ major: true }), undefined);
});

test('语义健康的风险分保留普通 JSON 数字编码', () => {
  const health =
    '{"jsonrpc":"2.0","method":"health.reported","params":{"atMs":144000,"ready":true,' +
    '"mode":"paused","goalId":null,"decisionPointId":null,"prerequisites":[],' +
    '"frameAgeMs":0,"queueDepth":0,"firstActionMs":null,"riskScore":1e0,' +
    '"riskLimitExceeded":false,"lastRejection":null}}';
  assert.ok(checkGameBridgeMessage(Role.Main, 'runtime', parseGameBridgeJson(health)));
});

test('错误编号用整数字面量，JSON-RPC 的错误详情可以带小数', () => {
  const wire =
    '{"jsonrpc":"2.0","id":1,"error":{"code":-32004,"message":"lease refused","data":{"rank":7.0}}}';
  assert.deepEqual(parseGameBridgeJson(wire), JSON.parse(wire));
  for (const invalidCode of ['-32004.0', '-32004e0', '-0', '9007199254740993']) {
    assert.throws(() => parseGameBridgeJson(wire.replace('-32004', invalidCode)), SyntaxError);
  }
});

test('语义握手读取适配包扩展与前置条件，控制握手拒绝语义字段', () => {
  const result = (value: unknown) => ({ jsonrpc: '2.0', id: 1, result: value });
  assert.ok(checkGameBridgeSuccess(Role.Main, Method.Describe, result(mainDescription)));
  assert.equal(checkGameBridgeSuccess(Role.Core, Method.Describe, result(mainDescription)), false);
  for (const screenTypes of [
    [{ name: '菜单', base: '菜单' }],
    [{ name: '调查', base: '卡住' }],
    [
      { name: '调查', base: '菜单' },
      { name: '调查', base: '地图' },
    ],
  ]) {
    const adapter = { ...mainDescription.adapter, screenTypes };
    assert.equal(
      checkGameBridgeSuccess(Role.Main, Method.Describe, result({ ...mainDescription, adapter })),
      false,
    );
  }
});

const situation = {
  atMs: 144_000,
  screenType: '菜单',
  screenTypeExtension: '调查',
  summary: '发现一条线索',
  currentLine: null,
  interactables: ['翻看抽屉'],
  lookpoints: [
    {
      id: 'look-1',
      kind: 'evidence',
      summary: '发现一条线索',
      importance: 'medium',
      atMs: 143_900,
    },
  ],
  voiceActivity: 'unknown',
  rereading: false,
  failure: null,
  traceparent: null,
} satisfies GameSituationObserved;

test('局面摘要保留通用分类和扩展，拒绝额外内容及未来的看点时刻', () => {
  const check = (params: unknown) =>
    checkGameBridgeParams(Role.Main, 'runtime', Method.SituationObserved, params);
  assert.ok(check(situation));
  assert.equal(check({ ...situation, history: ['整段剧情'] }), false);
  assert.equal(check({ ...situation, screenType: '调查' }), false);
  assert.equal(check({ ...situation, screenType: '未知' }), false);
  assert.equal(check({ ...situation, summary: '一'.repeat(601) }), false);
  assert.equal(check({ ...situation, atMs: 143_800 }), false);
});

const point = {
  decisionPointId: 'point-12',
  atMs: 144_000,
  prompt: '选择线索',
  options: [
    { id: 'a', label: '抽屉' },
    { id: 'b', label: '信封' },
  ],
  candidates: [
    { optionId: 'b', rank: 1, reason: '由近处查起', citation: null, previousFailure: null },
  ],
  timing: { resolveByMs: 144_150, deadlineMs: 144_350 },
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
} satisfies GameDecisionPointOpened;

test('计时决策点需要有效余量线与可执行的候选排序', () => {
  const check = (params: unknown) =>
    checkGameBridgeParams(Role.Main, 'runtime', Method.DecisionPointOpened, params);
  assert.ok(check(point));
  assert.ok(check({ ...point, timing: null, candidates: [] }));
  assert.equal(check({ ...point, candidates: [] }), false);
  assert.equal(check({ ...point, options: [point.options[0], point.options[0]] }), false);
  assert.equal(check({ ...point, candidates: [{ ...point.candidates[0], optionId: 'c' }] }), false);
  assert.equal(check({ ...point, candidates: [{ ...point.candidates[0], rank: 2 }] }), false);
  assert.equal(check({ ...point, timing: { ...point.timing, resolveByMs: point.atMs } }), false);
  assert.equal(
    check({ ...point, timing: { ...point.timing, resolveByMs: point.timing.deadlineMs } }),
    false,
  );
});

test('投票等待绑定实例，已执行的选择报告实际来源', () => {
  const goal = {
    goalId: 'goal-9',
    objective: '寻找线索',
    constraints: [],
    mode: 'waiting_vote',
    decisionPointId: point.decisionPointId,
    expiresAtMs: 150_000,
    traceparent: point.traceparent,
  };
  const checkGoal = (params: unknown) =>
    checkGameBridgeParams(Role.Main, 'bellis', Method.GoalSubmit, params);
  assert.ok(checkGoal(goal));
  assert.equal(checkGoal({ ...goal, decisionPointId: null }), false);
  assert.equal(checkGoal({ ...goal, mode: 'autonomous' }), false);

  const choice = { decisionPointId: point.decisionPointId, optionId: 'b', source: 'default' };
  const action = {
    actionId: 'action-25',
    atMs: 144_250,
    category: 'select',
    goalId: goal.goalId,
    summary: '打开信封',
    selection: choice,
    traceparent: point.traceparent,
  };
  const checkAction = (params: unknown) =>
    checkGameBridgeParams(Role.Main, 'runtime', Method.ActionCommitted, params);
  assert.ok(checkAction(action));
  assert.equal(checkAction({ ...action, selection: null }), false);
  assert.equal(checkAction({ ...action, category: 'advance' }), false);
  assert.equal(
    checkGameBridgeParams(Role.Main, 'bellis', Method.DecisionResolve, {
      ...choice,
      traceparent: point.traceparent,
    }),
    false,
  );
});
