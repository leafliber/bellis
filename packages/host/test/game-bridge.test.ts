import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import {
  type Connection,
  connect,
  createChannelPath,
  createSessionKey,
  listen,
  RpcError,
  RpcPeer,
} from '@bellis/channel';
import {
  GAME_GOAL,
  GAME_INPUT,
  type Game,
  GameRuntimeHost,
  GameRuntimePortService,
  GameService,
  gameBridge,
  gameControlLedger,
} from '@bellis/game-bridge';
import { ClockService, catalog, Kernel, ManualClock } from '@bellis/kernel';
import {
  GAME_LEASE_REFUSED,
  type GameCoreHealth,
  type GameDecisionPointOpened,
  type GameGoalSubmitParams,
  type GameInputReleased,
  type GameLeaseRenewParams,
  type GameMainHealth,
  Role as HostRole,
  GameBridgeMethod as Method,
  GameBridgeRole as Role,
  RpcErrorCode,
} from '@bellis/protocol';
import { SafetyCore, SafetyService, safetyFacade } from '@bellis/safety';
import { SimulatedCrash, StateStore } from '@bellis/store';
import { MemoryObs } from '../../sim/src/memory-obs.ts';
import { createOperator } from '../src/operator.ts';

const WIRE_EPOCH = 100_000;
const ADAPTER = { id: 'synthetic-game', version: '1', screenTypes: [] };
const CONDITION = { id: 'prepare', text: '确认合成场景就绪', confirmed: true };
const SOURCE = { origin: 'director', inputs: [], untrusted: true };

async function until(check: () => boolean, detail = '等待本机消息'): Promise<void> {
  const end = performance.now() + 1_500;
  while (!check()) {
    assert.ok(performance.now() < end, detail);
    await flush();
  }
}

type SetupOptions = {
  simulation?: boolean;
  simulatedPort?: boolean;
  storePath?: string;
  fault?: (point: string) => void;
};

async function setup(options: SetupOptions = {}) {
  const clock = new ManualClock();
  const wireNowMs = () => WIRE_EPOCH + Math.floor(clock.now());
  const store = StateStore.open({
    path: options.storePath ?? ':memory:',
    projections: [gameControlLedger],
    ...(options.fault ? { fault: options.fault } : {}),
  });
  store.recover();
  const obs = new MemoryObs();
  let kernel: Kernel | undefined;
  let watchdog: Connection | undefined;
  const safety = new SafetyCore({
    store,
    clock,
    config: {
      simulation: options.simulation ?? false,
      leaseTtlMs: { [GAME_INPUT]: 500 },
      leaseCapabilities: { [GAME_INPUT]: GAME_INPUT },
      presenceTtlMs: 60_000,
      rateLimits: {},
      guardTimeoutMs: 50,
      emergency: { stageSource: 'Stage', safeScene: 'Safe', stopStream: false },
      unattendedGatesSatisfied: false,
    },
    obs,
    permissionsOf: (holder) => kernel?.permissionsOf(holder),
    watchdogConnected: () => watchdog?.isOpen === true,
  });
  kernel = new Kernel({ clock, safety: safety.kernelHooks() });
  const host = new GameRuntimeHost({
    simulated: options.simulatedPort ?? false,
    wireNowMs,
    emergencyStop: (reason) => {
      void safety.emergencyStop(reason);
    },
  });
  kernel.provideCore(GameRuntimePortService, host.port);
  kernel.provideCore(ClockService, clock);
  kernel.provideScoped(SafetyService, ({ instanceId, permissions }) =>
    safetyFacade(safety, instanceId, permissions),
  );
  kernel.add(
    [
      {
        id: 'game',
        plugin: gameBridge.manifest.id,
        disabled: false,
        explicitSwitch: true,
        grant: [GAME_GOAL, GAME_INPUT],
        config: { adapterId: ADAPTER.id, adapterVersion: ADAPTER.version },
      },
    ],
    catalog(gameBridge),
  );
  await kernel.settled();
  const registered = kernel.services.resolve(GameService.name, GameService.major);
  assert.ok(!('missing' in registered));
  const game = registered.impl as Game;
  const key = createSessionKey();
  const path = createChannelPath('p3test');
  const server = await listen(path, {
    key,
    onConnection(connection) {
      if (connection.role === HostRole.Watchdog) watchdog = connection;
      else if (!host.accept(connection)) connection.close();
    },
    onRejected: () => {},
    onError: (error) => {
      throw error;
    },
  });
  await connect(path, HostRole.Watchdog, { key });
  const operator = createOperator({
    core: safety,
    subscribe: (listener) => store.subscribe(listener),
    plugins: () => kernel?.snapshot() ?? [],
    presentation: () => null,
    review: () => null,
    preflight: async () => ['本测试通过 SafetyCore 设置监督模式'],
    consoleLogin: () => undefined,
  });
  return {
    clock,
    wireNowMs,
    game,
    host,
    path,
    key,
    safety,
    store,
    operator,
    async mode() {
      safety.confirmPresence();
      assert.deepEqual(safety.requestMode(options.simulation ? 'M0' : 'M2'), { ok: true });
      await flush();
    },
    async close() {
      await server.close();
      await kernel.shutdown();
      operator.dispose();
      store.close();
    },
  };
}

type Harness = Awaited<ReturnType<typeof setup>>;

async function peer(h: Harness, role: Role, description: () => object) {
  const connection = await connect(h.path, role, { key: h.key });
  const rpc = new RpcPeer(connection, { timeoutMs: 1_000 });
  rpc.handle(Method.Describe, () => description());
  return { rpc, connection };
}

async function main(h: Harness, run = 'run', describe?: () => object) {
  const p = await peer(
    h,
    Role.Main,
    describe ??
      (() => ({
        major: 1,
        runtimeId: run,
        nowMs: h.wireNowMs(),
        adapter: ADAPTER,
        prerequisites: [CONDITION],
      })),
  );
  const submissions: string[] = [];
  let answer: () => unknown = () => ({});
  for (const method of [Method.GoalSubmit, Method.DecisionResolve]) {
    p.rpc.handle(method, () => {
      submissions.push(method);
      return answer();
    });
  }
  return {
    ...p,
    submissions,
    answerWith(handle: () => unknown) {
      answer = handle;
    },
    health(patch: Partial<GameMainHealth> = {}) {
      p.rpc.notify(Method.HealthReported, {
        atMs: h.wireNowMs(),
        ready: true,
        mode: 'autonomous',
        goalId: null,
        decisionPointId: null,
        prerequisites: [CONDITION],
        firstActionMs: null,
        frameAgeMs: 0,
        queueDepth: 0,
        riskScore: 0,
        riskLimitExceeded: false,
        lastRejection: null,
        ...patch,
      } satisfies GameMainHealth);
    },
  };
}

/** 替身的唯一输入权来自真实 SafetyCore 经控制连接发来的有效许可。 */
async function realtime(h: Harness, run = 'run') {
  const clock = new ManualClock(h.clock.now());
  const now = () => WIRE_EPOCH + Math.floor(clock.now());
  const p = await peer(h, Role.Core, () => ({ major: 1, runtimeId: run, nowMs: now() }));
  let lease: GameLeaseRenewParams | undefined;
  let through = 0;
  let held = false;
  let expiry: ReturnType<ManualClock['setTimeout']> | undefined;
  let verification: GameInputReleased['verification'] = 'verified';
  let renewReply: unknown = {};
  const renewals: GameLeaseRenewParams[] = [];
  const stops: number[] = [];
  const releases: GameInputReleased['reason'][] = [];
  const release = (reason: GameInputReleased['reason'], token = lease?.token ?? null) => {
    if (expiry) clock.clearTimeout(expiry);
    expiry = undefined;
    lease = undefined;
    held = verification === 'residual';
    releases.push(reason);
    if (p.connection.isOpen)
      p.rpc.notify(Method.InputReleased, {
        token,
        atMs: now(),
        reason,
        verification,
      } satisfies GameInputReleased);
  };
  p.rpc.handle(Method.LeaseRenew, (params) => {
    const { token, expiresAtMs } = params as unknown as GameLeaseRenewParams;
    if (token <= through || expiresAtMs <= now() || (lease && token < lease.token)) {
      throw new RpcError(GAME_LEASE_REFUSED, 'invalid lease');
    }
    if (expiry) clock.clearTimeout(expiry);
    lease = { token, expiresAtMs };
    renewals.push(lease);
    expiry = clock.setTimeout(() => {
      through = token;
      release('lease_expired');
    }, expiresAtMs - now());
    return renewReply;
  });
  p.rpc.handle(Method.InputStop, (params) => {
    const token = params.throughToken as number;
    stops.push(token);
    through = Math.max(through, token);
    if (!lease || lease.token <= through) release('lease_revoked', token);
    return {};
  });
  p.connection.once('close', () => release('lease_source_lost'));
  return {
    ...p,
    clock,
    renewals,
    stops,
    releases,
    release,
    get held() {
      return held;
    },
    setVerification(value: GameInputReleased['verification']) {
      verification = value;
    },
    setRenewReply(value: unknown) {
      renewReply = value;
    },
    input() {
      if (!p.connection.isOpen || !lease || now() >= lease.expiresAtMs) return false;
      held = true;
      return true;
    },
    health(patch: Partial<GameCoreHealth> = {}) {
      p.rpc.notify(Method.HealthReported, {
        atMs: now(),
        leaseState: lease ? 'valid' : 'not_granted',
        frameAgeMs: 0,
        queueDepth: 0,
        ...patch,
      } satisfies GameCoreHealth);
    },
  };
}

async function pair(h: Harness, run = 'run') {
  const semantic = await main(h, run);
  const core = await realtime(h, run);
  semantic.health();
  core.health();
  await until(() => h.game.status().state === 'READY');
  return { semantic, core };
}

const goal = (h: Harness, goalId = 'g-1'): GameGoalSubmitParams => ({
  goalId,
  objective: '检查合成场景的线索',
  constraints: [],
  mode: 'autonomous',
  decisionPointId: null,
  expiresAtMs: h.wireNowMs() + 500,
  traceparent: null,
});

function point(h: Harness, id = 'd-1'): GameDecisionPointOpened {
  return {
    decisionPointId: id,
    atMs: h.wireNowMs(),
    prompt: '选择线索',
    options: [{ id: 'a', label: '选项 A' }],
    candidates: [],
    timing: null,
    traceparent: null,
  };
}

test('命名管道或 UDS 需要认证、每角色一个槽位，未来主版本进入 WAITING', async () => {
  const h = await setup();
  try {
    await assert.rejects(connect(h.path, Role.Core, { key: createSessionKey() }), {
      code: 'auth-failed',
    });
    const future = await main(h, 'run', () => ({ major: 2, extra: { format: 'future' } }));
    await until(() => h.game.status().reason?.includes('Game Runtime 2') === true);
    const duplicate = await main(h);
    await until(() => !duplicate.connection.isOpen);
    assert.equal(h.game.status().state, 'WAITING');
    assert.equal(h.game.status().inputPermitted, false);
    const wrongCore = await realtime(h, 'other-run');
    future.connection.close();
    await until(() => !h.game.status().mainConnected);
    await main(h);
    await until(() => h.game.status().reason?.includes('会话不一致') === true);
    await h.mode();
    assert.equal(wrongCore.input(), false);
    assert.equal(wrongCore.renewals.length, 0);
  } finally {
    await h.close();
  }
});

test('健康、适配包和共同时钟门禁生效，续约使用绝对时刻并在 250 ms 发出', async () => {
  const h = await setup();
  try {
    const wrong = await main(h, 'run', () => ({
      major: 1,
      runtimeId: 'run',
      nowMs: 100,
      adapter: ADAPTER,
      prerequisites: [CONDITION],
    }));
    await until(() => h.game.status().reason?.includes('单调时钟') === true);
    wrong.connection.close();
    await until(() => !h.game.status().mainConnected);
    const wrongAdapter = await main(h, 'run', () => ({
      major: 1,
      runtimeId: 'run',
      nowMs: h.wireNowMs(),
      adapter: { ...ADAPTER, version: '2' },
      prerequisites: [CONDITION],
    }));
    await until(() => h.game.status().reason?.includes('适配包') === true);
    wrongAdapter.connection.close();
    await until(() => !h.game.status().mainConnected);
    const semantic = await main(h);
    const core = await realtime(h);
    semantic.health({ prerequisites: [{ ...CONDITION, confirmed: false }] });
    core.health();
    await until(() => h.game.status().reason?.includes('前置条件') === true);
    await h.mode();
    assert.equal(core.input(), false);
    semantic.health();
    await until(() => h.game.status().inputPermitted);
    const first = core.renewals[0];
    assert.deepEqual(first, { token: h.store.token(GAME_INPUT), expiresAtMs: WIRE_EPOCH + 500 });
    core.clock.advance(249);
    h.clock.advance(249);
    await flush();
    assert.equal(core.renewals.length, 1);
    core.clock.advance(1);
    h.clock.advance(1);
    await until(() => core.renewals.length === 2);
    assert.equal(h.game.wireNowMs(), WIRE_EPOCH + 250);
    assert.deepEqual(core.renewals[1], { token: first?.token, expiresAtMs: WIRE_EPOCH + 750 });
    assert.equal(core.input(), true);
    // 停住宿主时钟，独立实时核到期释放。
    core.clock.advance(500);
    assert.equal(core.held, false);
    assert.equal(core.input(), false);
    assert.ok(core.releases.includes('lease_expired'));
  } finally {
    await h.close();
  }
});

test('M0 的授权只到无真实后端的仿真入口', async () => {
  for (const simulatedPort of [false, true]) {
    const h = await setup({ simulation: true, simulatedPort });
    try {
      const { core } = await pair(h);
      await h.mode();
      if (simulatedPort) await until(() => h.game.status().inputPermitted);
      assert.equal(core.input(), simulatedPort);
      assert.equal(core.renewals.length, simulatedPort ? 1 : 0);
    } finally {
      await h.close();
    }
  }
});

test('急停发 input.stop 并等待核验，维护态保持零输入', async () => {
  const h = await setup();
  try {
    const { core } = await pair(h);
    await h.mode();
    await until(() => h.game.status().inputPermitted);
    assert.equal(core.input(), true);
    const token = core.renewals[0]?.token;
    await h.safety.emergencyStop('测试急停');
    assert.deepEqual(h.safety.enterMaintenance(), { ok: true });
    await until(() => h.store.events().some((f) => f.type === Method.InputReleased));
    assert.deepEqual(core.stops, [token]);
    assert.equal(core.held, false);
    assert.equal(core.input(), false);
    assert.equal(h.game.status().inputPermitted, false);
    assert.equal((await h.game.submitGoal(goal(h), SOURCE)).ok, false);
    h.clock.advance(500);
    await flush();
    assert.equal(core.renewals.length, 1);
  } finally {
    await h.close();
  }
});

test('同步急停撤销刚发放的许可时，控制连接收不到许可', async () => {
  const h = await setup();
  try {
    const { core } = await pair(h);
    const unsubscribe = h.safety.leases.subscribe(({ resource, lease }) => {
      if (resource === GAME_INPUT && lease) void h.safety.emergencyStop('授予过程中急停');
    });
    await h.mode();
    unsubscribe();
    assert.equal(h.safety.mode, 'safe-stop');
    assert.equal(h.game.status().inputPermitted, false);
    assert.equal(core.renewals.length, 0);
    assert.equal(core.input(), false);
  } finally {
    await h.close();
  }
});

test('授予许可的订阅者同步接管时，宿主归还许可且控制连接收不到它', async () => {
  const h = await setup();
  try {
    const { core } = await pair(h);
    let grantedToken: number | undefined;
    const unsubscribe = h.safety.leases.subscribe(({ resource, lease }) => {
      if (resource !== GAME_INPUT || !lease) return;
      grantedToken = lease.token;
      h.host.takeOver();
    });
    await h.mode();
    unsubscribe();
    assert.ok(grantedToken !== undefined);
    assert.equal(h.safety.mode, 'M2');
    assert.equal(h.game.status().state, 'MANUAL');
    assert.equal(h.safety.leases.current(GAME_INPUT), undefined);
    assert.equal(h.safety.leases.isValid(GAME_INPUT, grantedToken), false);
    assert.equal(core.renewals.length, 0);
    assert.equal(core.input(), false);
  } finally {
    await h.close();
  }
});

test('未确认的许可不能派发目标，无效确认使输入停止', async () => {
  const h = await setup();
  try {
    const { semantic, core } = await pair(h);
    const ack = Promise.withResolvers<unknown>();
    core.setRenewReply(ack.promise);
    await h.mode();
    await until(() => core.renewals.length === 1);
    assert.equal(h.game.status().inputPermitted, false);
    assert.equal((await h.game.submitGoal(goal(h), SOURCE)).ok, false);
    assert.deepEqual(semantic.submissions, []);
    ack.resolve({ invalid: true });
    await until(() => core.stops.length === 1);
    assert.equal(h.game.status().state, 'MANUAL');
    assert.equal(core.input(), false);
  } finally {
    await h.close();
  }
});

test('失焦与接管锁存，未核验时拒绝交还，操作员交还换令牌', async () => {
  const h = await setup();
  try {
    const { semantic, core } = await pair(h);
    await h.mode();
    await until(() => h.game.status().inputPermitted);
    assert.equal(core.input(), true);
    const token = core.renewals[0]?.token ?? 0;
    core.setVerification('residual');
    core.release('focus_lost');
    await until(() => core.stops.length === 1);
    assert.equal(h.game.status().state, 'MANUAL');
    assert.equal(h.host.returnControl().ok, false);
    assert.equal(core.input(), false);
    assert.equal((await h.game.submitGoal(goal(h), SOURCE)).ok, false);
    core.setVerification('verified');
    core.release('core_start', null);
    await until(() =>
      h.store
        .events()
        .some(
          (f) =>
            f.type === Method.InputReleased &&
            (f.data as { payload: GameInputReleased }).payload.token === null,
        ),
    );
    assert.equal(h.host.returnControl().ok, false);
    core.release('lease_revoked', token);
    await until(() =>
      h.store
        .events()
        .some(
          (f) =>
            f.type === Method.InputReleased &&
            (f.data as { payload: GameInputReleased }).payload.token === token &&
            (f.data as { payload: GameInputReleased }).payload.verification === 'verified',
        ),
    );
    assert.equal(core.renewals.length, 1);
    assert.deepEqual(h.host.returnControl(), { ok: true });
    await until(() => h.game.status().inputPermitted);
    assert.ok((core.renewals[1]?.token ?? 0) > token);
    core.release('takeover');
    await until(() => h.game.status().state === 'MANUAL');
    semantic.health();
    core.health();
    await flush();
    assert.equal(core.input(), false);
  } finally {
    await h.close();
  }
});

test('实时核主动报告当前令牌的残留或未核验，立即撤销许可并进入人工', async () => {
  for (const verification of ['residual', 'unverified'] as const) {
    const h = await setup();
    try {
      const { semantic, core } = await pair(h);
      await h.mode();
      await until(() => h.game.status().inputPermitted);
      assert.equal(core.input(), true);
      assert.deepEqual(core.stops, []);
      core.setVerification(verification);
      core.release('producer_changed');
      await until(() =>
        h.store
          .events()
          .some(
            (event) =>
              event.type === Method.InputReleased &&
              (event.data as { payload: GameInputReleased }).payload.reason === 'producer_changed',
          ),
      );
      assert.equal(h.game.status().state, 'MANUAL', verification);
      assert.equal(h.game.status().inputPermitted, false);
      assert.equal(h.safety.leases.current(GAME_INPUT), undefined);
      await until(() => core.stops.length === 1);
      core.clock.advance(250);
      h.clock.advance(250);
      semantic.health();
      core.health();
      await flush();
      assert.equal(core.renewals.length, 1);
      assert.equal(core.input(), false);
      assert.equal(h.host.returnControl().ok, false);
    } finally {
      await h.close();
    }
  }
});

test('意图经安全核授权，RPC 应答与动作事实分离，旧连接的决策与重复事实不分发', async () => {
  const h = await setup();
  try {
    const { semantic, core } = await pair(h);
    await h.mode();
    await until(() => h.game.status().inputPermitted);
    const unregister = h.safety.addGuard((request) =>
      request.type === Method.GoalSubmit ? { deny: '测试守卫拒绝' } : undefined,
    );
    assert.equal((await h.game.submitGoal(goal(h), SOURCE)).ok, false);
    assert.deepEqual(semantic.submissions, []);
    unregister();
    assert.equal((await h.game.submitGoal(goal(h), SOURCE)).ok, true);
    assert.equal(
      h.store.events().some((f) => f.type === Method.ActionCommitted),
      false,
    );
    const factSeq: number[] = [];
    const unsubscribe = h.game.subscribe((fact) => {
      if (fact.method === Method.ActionCommitted) {
        factSeq.push(h.store.events().find((stored) => stored.seq === fact.seq)?.seq ?? -1);
      }
    });
    semantic.rpc.notify(Method.DecisionPointOpened, point(h));
    await until(() => h.game.status().decision !== null);
    const committed = {
      actionId: 'a-1',
      atMs: h.wireNowMs(),
      goalId: 'g-1',
      category: 'navigate',
      summary: '到达目标',
      selection: null,
      traceparent: null,
    };
    semantic.rpc.notify(Method.ActionCommitted, committed);
    await until(() => factSeq.length === 1);
    assert.ok((factSeq[0] ?? -1) > 0);
    const stopped = once(semantic.connection, 'close');
    core.clock.advance(50);
    h.clock.advance(50);
    semantic.connection.close();
    await stopped;
    await until(() => !h.game.status().mainConnected && core.stops.length === 1);
    const replacement = await main(h);
    replacement.health();
    core.health();
    await until(() => h.game.status().inputPermitted);
    replacement.rpc.notify(Method.ActionCommitted, committed);
    replacement.rpc.notify(Method.ActionCommitted, { ...committed, actionId: 'late-old-time' });
    replacement.rpc.notify(Method.DecisionPointOpened, point(h, 'd-new'));
    await until(() => h.game.status().decision?.decisionPointId === 'd-new');
    assert.equal(factSeq.length, 1);
    const late = await h.game.resolveDecision(
      { decisionPointId: 'd-1', optionId: 'a', source: 'director', traceparent: null },
      SOURCE,
    );
    assert.equal(late.ok, false);
    unsubscribe();
  } finally {
    await h.close();
  }
});

test('选择发出后语义连接断开，回执不明时停止并持久化隔离', async () => {
  const h = await setup();
  try {
    const { semantic, core } = await pair(h);
    await h.mode();
    await until(() => h.game.status().inputPermitted);
    semantic.rpc.notify(Method.DecisionPointOpened, point(h));
    await until(() => h.game.status().decision !== null);
    const ack = Promise.withResolvers<unknown>();
    semantic.answerWith(() => ack.promise);
    const applying = h.game.resolveDecision(
      {
        decisionPointId: 'd-1',
        optionId: 'a',
        source: 'director',
        traceparent: null,
      },
      SOURCE,
    );
    await until(() => semantic.submissions.length === 1);
    semantic.connection.close();
    const result = await applying;
    ack.resolve({});
    assert.equal(result.intent?.state, 'unknown');
    await until(() => core.stops.length === 1);
    assert.equal(core.input(), false);
    const replacement = await main(h);
    replacement.health();
    await until(() => h.game.status().reason?.includes('隔离') === true);
    assert.equal(core.renewals.length, 1);
    assert.deepEqual(replacement.submissions, []);
  } finally {
    await h.close();
  }
});

test('计时选择的无效回执持久化为 unknown，操作员结案前隔离输入和重发', async () => {
  const h = await setup();
  try {
    const { semantic, core } = await pair(h);
    await h.mode();
    await until(() => h.game.status().inputPermitted);
    const pending = point(h);
    semantic.rpc.notify(Method.DecisionPointOpened, {
      ...pending,
      candidates: [
        { optionId: 'a', rank: 1, reason: '证据已核对', citation: null, previousFailure: null },
      ],
      timing: { resolveByMs: h.wireNowMs() + 250, deadlineMs: h.wireNowMs() + 400 },
    });
    await until(() => h.game.status().decision !== null);
    semantic.answerWith(() => ({ unknownField: true }));
    const choice = {
      decisionPointId: pending.decisionPointId,
      optionId: 'a',
      source: 'director' as const,
      traceparent: null,
    };
    const result = await h.game.resolveDecision(choice, SOURCE);
    assert.equal(result.ok, false);
    const intent = h.store.intentsIn('unknown')[0];
    assert.ok(intent);
    assert.deepEqual(semantic.submissions, [Method.DecisionResolve]);
    assert.equal(h.game.status().inputPermitted, false);
    await until(() => core.stops.length === 1);
    assert.equal(core.input(), false);
    assert.equal((await h.game.resolveDecision(choice, SOURCE)).ok, false);
    assert.deepEqual(semantic.submissions, [Method.DecisionResolve]);
    assert.equal(h.operator.resolve({ id: intent.id, outcome: 'failed' }).ok, true);
    semantic.health({ decisionPointId: pending.decisionPointId });
    await until(() => h.game.status().inputPermitted);
    assert.equal((await h.game.resolveDecision(choice, SOURCE)).ok, false);
    assert.deepEqual(semantic.submissions, [Method.DecisionResolve]);
  } finally {
    await h.close();
  }
});

test('断开控制连接释放输入，重连后只接受新核的消息和更大令牌', async () => {
  const h = await setup();
  try {
    const { semantic, core } = await pair(h);
    await h.mode();
    await until(() => h.game.status().inputPermitted);
    assert.equal(core.input(), true);
    const first = core.renewals[0]?.token ?? 0;
    const closed = once(core.connection, 'close');
    core.connection.close();
    await closed;
    await until(() => h.game.status().state === 'WAITING');
    assert.equal(core.held, false);
    assert.equal(core.input(), false);
    const restarted = await realtime(h);
    restarted.health();
    semantic.health();
    await until(() => h.game.status().inputPermitted);
    assert.ok((restarted.renewals[0]?.token ?? 0) > first);
    restarted.rpc.notify(Method.InputReleased, {
      token: first,
      atMs: h.wireNowMs(),
      reason: 'takeover',
      verification: 'verified',
    });
    restarted.health();
    await flush();
    assert.equal(h.game.status().state, 'READY');
    assert.equal(restarted.input(), true);
    semantic.rpc.notify(Method.InputReleased, {
      token: first,
      atMs: h.wireNowMs(),
      reason: 'takeover',
      verification: 'verified',
    });
    await until(() => !semantic.connection.isOpen);
    await until(() => restarted.stops.length === 1 && !restarted.held);
  } finally {
    await h.close();
  }
});

test('RPC 明确拒绝结束意图，进程崩溃留下的执行中意图恢复为 unknown', async () => {
  const path = join(tmpdir(), `bellis-game-restart-${randomUUID()}.db`);
  let failAfter = false;
  const original = await setup({
    storePath: path,
    fault: (at) => {
      if (failAfter && at === 'effect:after') throw new SimulatedCrash(at);
    },
  });
  try {
    const { semantic } = await pair(original);
    await original.mode();
    await until(() => original.game.status().inputPermitted);
    semantic.answerWith(() => {
      throw new RpcError(RpcErrorCode.InvalidParams, 'rejected before execution');
    });
    const rejected = await original.game.submitGoal(goal(original, 'refused'), SOURCE);
    assert.equal(rejected.intent?.state, 'failed');
    assert.equal(original.store.intentsIn('unknown').length, 0);
    semantic.answerWith(() => ({}));
    failAfter = true;
    await assert.rejects(original.game.submitGoal(goal(original), SOURCE), SimulatedCrash);
    assert.equal(original.store.intentsIn('executing').length, 1);
  } finally {
    await original.close();
  }
  const reboot = await setup({ storePath: path });
  try {
    const semantic = await main(reboot);
    const core = await realtime(reboot);
    semantic.health();
    core.health();
    await until(() => reboot.game.status().reason?.includes('隔离') === true);
    assert.equal(reboot.safety.mode, 'safe-stop');
    await reboot.mode();
    assert.equal(core.input(), false);
    assert.equal((await reboot.game.submitGoal(goal(reboot), SOURCE)).ok, false);
    assert.deepEqual(semantic.submissions, []);
    assert.equal(reboot.store.intentsIn('unknown').length, 1);
  } finally {
    await reboot.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  }
});
