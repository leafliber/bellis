import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { type Danmaku, DanmakuService, triage, vote, voteLedger } from '@bellis/audience';
import {
  type Connection,
  connect,
  createChannelPath,
  createSessionKey,
  listen,
  RpcError,
  RpcPeer,
} from '@bellis/channel';
import { director, LlmService } from '@bellis/director';
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
import {
  ClockService,
  catalog,
  DeadlineError,
  definePlugin,
  Kernel,
  ManualClock,
} from '@bellis/kernel';
import { MemoryService } from '@bellis/memory';
import {
  GAME_LEASE_REFUSED,
  type GameCoreHealth,
  type GameDecisionPointOpened,
  type GameGoalSubmitParams,
  type GameInputReleased,
  type GameLeaseRenewParams,
  type GameMainHealth,
  type GameSituationObserved,
  Role as HostRole,
  GameBridgeMethod as Method,
  GameBridgeRole as Role,
  RpcErrorCode,
  type RpcParams,
} from '@bellis/protocol';
import { SafetyCore, SafetyService, safetyFacade } from '@bellis/safety';
import {
  PreCheck,
  type Speech,
  type SpeechRequest,
  SpeechService,
  simTts,
  speechArbiter,
  type UtteranceOutcome,
} from '@bellis/speech';
import { type PlaybackResult, STAGE_AUDIO, StageService } from '@bellis/stage';
import { SimulatedCrash, StateStore } from '@bellis/store';
import Type from 'typebox';
import type { PendingCall } from '../../director/test/helpers.ts';
import { MemoryObs } from '../../sim/src/memory-obs.ts';
import { createOperator } from '../src/operator.ts';
import {
  SYNTHETIC_INJECTION,
  syntheticPoint,
  syntheticSituation,
} from './fixtures/game-director.ts';

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
  director?: Record<string, unknown>;
  gamePacing?: { holdMs?: number; voiceWaitMs?: number };
};

function addSpeech(
  kernel: Kernel,
  safety: SafetyCore,
  gamePacing: NonNullable<SetupOptions['gamePacing']>,
) {
  const plays: string[] = [];
  const pending = new Map<string, PromiseWithResolvers<PlaybackResult>>();
  const finish = (sentenceId: string, complete: boolean) => {
    const playback = pending.get(sentenceId);
    assert.ok(playback, sentenceId);
    pending.delete(sentenceId);
    playback.resolve({ sentenceId, played: 0, complete });
  };
  kernel.provideCore(StageService, {
    ready: true,
    presentation: { delayMs: 0, samples: 0, source: 'none' },
    play(sentence, _audio, token) {
      assert.ok(safety.leases.isValid(STAGE_AUDIO, token));
      plays.push(sentence.id);
      const playback = Promise.withResolvers<PlaybackResult>();
      pending.set(sentence.id, playback);
      return playback.promise;
    },
    truncate: (sentenceId) => {
      if (pending.has(sentenceId)) finish(sentenceId, false);
    },
    onEvent: () => () => {},
    envelope: () => undefined,
    setPresentation() {},
  });
  kernel.add(
    [
      {
        id: 'speech',
        plugin: 'speech-arbiter',
        config: { gamePacing },
        disabled: false,
        explicitSwitch: false,
        grant: ['speech.output'],
      },
      {
        id: 'tts',
        plugin: 'tts-sim',
        config: {},
        disabled: false,
        explicitSwitch: false,
        grant: [],
      },
    ],
    catalog(speechArbiter, simTts),
  );
  return {
    plays,
    finish,
    speech(): Speech {
      const found = kernel.services.resolve(SpeechService.name, SpeechService.major);
      assert.ok(!('missing' in found));
      return found.impl as Speech;
    },
  };
}

function addDirector(kernel: Kernel, config: Record<string, unknown>) {
  const calls: PendingCall[] = [];
  const spoken: SpeechRequest[] = [];
  const heard: UtteranceOutcome[] = [];
  const listeners = new Set<(message: Danmaku) => void>();
  let recalls = 0;
  let messageId = 0;
  let speaking: ((outcome: UtteranceOutcome) => Promise<UtteranceOutcome>) | undefined;
  const modelPlugin = (acceptsGameContent: boolean) =>
    definePlugin({
      manifest: {
        id: 'test-llm',
        version: '0.0.0',
        tier: 'ordinary',
        process: 'in-process',
        provides: [LlmService.ref],
        inject: [],
        permissions: [],
        config: Type.Object({}),
      },
      activate(ctx) {
        ctx.provide(LlmService, {
          acceptsGameContent,
          complete(request, signal, options) {
            const { promise, resolve, reject } = Promise.withResolvers<string>();
            calls.push({ request, signal, options, resolve, reject });
            return promise;
          },
        });
      },
    });
  kernel.provideCore(SpeechService, {
    async request(request) {
      spoken.push(request);
      const outcome: UtteranceOutcome = {
        id: request.id,
        source: request.source,
        ...(request.gameContent ? { gameContent: true } : {}),
        heard: typeof request.text === 'string' ? request.text : '',
        interruptedMidSentence: false,
        end: 'complete',
        skipped: [],
      };
      const result = speaking ? await speaking(outcome) : outcome;
      if (result.heard) heard.push(result);
      return result;
    },
    heard: () => heard,
    softStop() {},
  });
  kernel.provideCore(DanmakuService, {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  kernel.provideCore(MemoryService, {
    async recall() {
      recalls += 1;
      return { ok: true, recall: { recallId: 'r', memories: [] } };
    },
    feedback() {},
    async check() {},
    persona: undefined,
    async currentPersona() {
      return undefined;
    },
    report: { ready: true, status: '测试', pending: 0, written: 0, dropped: 0, tombstones: 0 },
  });
  kernel.add(
    [
      {
        id: 'test-llm',
        plugin: 'test-llm',
        config: {},
        disabled: false,
        explicitSwitch: false,
        grant: [],
      },
      {
        id: 'director',
        plugin: 'director',
        config,
        disabled: false,
        explicitSwitch: false,
        grant: [],
      },
      {
        id: 'vote',
        plugin: 'audience-vote',
        config: {},
        disabled: false,
        explicitSwitch: false,
        grant: ['vote.start'],
      },
      {
        id: 'triage',
        plugin: 'audience-triage',
        config: {},
        disabled: false,
        explicitSwitch: false,
        grant: [],
      },
    ],
    catalog(modelPlugin(true), director, vote, triage),
  );
  return {
    calls,
    spoken,
    get recalls() {
      return recalls;
    },
    async replaceModel(acceptsGameContent: boolean) {
      assert.deepEqual(await kernel.replace('test-llm', modelPlugin(acceptsGameContent)), {
        ok: true,
      });
      await kernel.settled();
    },
    holdSpeech(hold: typeof speaking) {
      speaking = hold;
    },
    send(text: string) {
      const id = String(++messageId);
      for (const listener of listeners) listener({ id, viewer: id, nickname: '观众', text });
    },
  };
}

async function setup(options: SetupOptions = {}) {
  const clock = new ManualClock();
  const wireNowMs = () => WIRE_EPOCH + Math.floor(clock.now());
  const store = StateStore.open({
    path: options.storePath ?? ':memory:',
    projections: [gameControlLedger, voteLedger],
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
      leaseTtlMs: { [GAME_INPUT]: 500, [STAGE_AUDIO]: 2_000 },
      leaseCapabilities: { [GAME_INPUT]: GAME_INPUT, [STAGE_AUDIO]: 'speech.output' },
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
  const model = options.director ? addDirector(kernel, options.director) : undefined;
  const stage = options.gamePacing ? addSpeech(kernel, safety, options.gamePacing) : undefined;
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
    kernel,
    host,
    path,
    key,
    safety,
    store,
    operator,
    model,
    stage,
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
  const commands: unknown[] = [];
  const pacing: Array<{
    method: typeof Method.PacingHold | typeof Method.PacingRelease;
    params: RpcParams;
  }> = [];
  let answer: () => unknown = () => ({});
  for (const method of [Method.GoalSubmit, Method.DecisionResolve]) {
    p.rpc.handle(method, (params) => {
      submissions.push(method);
      commands.push(params);
      return answer();
    });
  }
  let answerPacing: (method: typeof Method.PacingHold | typeof Method.PacingRelease) => unknown =
    () => ({});
  for (const method of [Method.PacingHold, Method.PacingRelease] as const) {
    p.rpc.handle(method, (params) => {
      pacing.push({ method, params });
      return answerPacing(method);
    });
  }
  return {
    ...p,
    submissions,
    commands,
    pacing,
    answerPacingWith(handle: typeof answerPacing) {
      answerPacing = handle;
    },
    voice(voiceActivity: GameSituationObserved['voiceActivity'], atMs = h.wireNowMs()) {
      p.rpc.notify(Method.SituationObserved, syntheticSituation(atMs, { voiceActivity }));
    },
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
    get actualLease() {
      return lease;
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

const choice = (decisionPoint: string, optionId = 'desk') =>
  JSON.stringify({ action: 'choose', decisionPoint, optionId });
const quiet = JSON.stringify({ action: 'silence', reason: '' });

function commentary(h: Harness, id: string, overrides: Partial<SpeechRequest> = {}): SpeechRequest {
  return {
    id,
    source: 'game-reaction',
    text: '看这里。',
    expiresAt: h.clock.now() + 5_000,
    preempt: 'sentence',
    inputs: [],
    untrusted: true,
    ...overrides,
  };
}

test('一段游戏解说在首句播出前 hold，播完 release，多句与同句重入都复用这一段', async () => {
  const h = await setup({ simulation: true, gamePacing: { holdMs: 500, voiceWaitMs: 100 } });
  const { stage } = h;
  assert.ok(stage);
  try {
    const { semantic } = await pair(h);
    await h.mode();
    assert.equal(h.game.status().inputPermitted, false);
    const speech = stage.speech();
    const request = commentary(h, 'reaction', { text: '看这里。再看那边。' });
    const played = speech.request(request);
    await until(() => stage.plays.length === 1);
    const [hold] = semantic.pacing;
    assert.equal(hold?.method, Method.PacingHold);
    assert.equal(hold?.params.expiresAtMs, h.wireNowMs() + 500);
    assert.ok(h.store.events().some((e) => e.type === 'pacing.held'));
    assert.equal((await speech.request(request)).end, 'duplicate');
    stage.finish('reaction#0', true);
    await until(() => stage.plays.length === 2);
    assert.equal(semantic.pacing.length, 1);
    stage.finish('reaction#1', true);
    assert.equal((await played).end, 'complete');
    await until(() => h.store.events().some((e) => e.type === 'pacing.released'));
    assert.deepEqual(semantic.pacing[1], {
      method: Method.PacingRelease,
      params: { holdId: hold?.params.holdId, traceparent: null },
    });
    assert.equal(semantic.pacing.length, 2);
    assert.equal(h.store.events().filter((e) => e.type === 'intent.authorized').length, 2);

    const ordinary = speech.request(
      commentary(h, 'ordinary', { source: 'chatter', gameContent: true }),
    );
    await until(() => stage.plays.length === 3);
    stage.finish('ordinary#0', true);
    assert.equal((await ordinary).end, 'complete');
    assert.equal(semantic.pacing.length, 2);
  } finally {
    await h.close();
  }
});

test('显式解说保留回复来源，等配音转闲后才发送 hold', async () => {
  const h = await setup({ simulation: true, gamePacing: { voiceWaitMs: 200 } });
  const { stage } = h;
  assert.ok(stage);
  try {
    const { semantic } = await pair(h);
    await h.mode();
    semantic.voice('busy');
    await until(() => h.game.pacing()?.voiceActivity() === 'busy');
    const played = stage.speech().request(
      commentary(h, 'reply', {
        source: 'danmaku-reply',
        commentary: { runtimeId: 'run' },
      }),
    );
    await until(() => h.store.intentByKey('reply#0')?.state === 'executing');
    assert.equal(semantic.pacing.length, 0);
    assert.equal(stage.plays.length, 0);
    h.clock.advance(50);
    semantic.voice('idle');
    await until(() => stage.plays.length === 1);
    assert.equal(semantic.pacing[0]?.method, Method.PacingHold);
    stage.finish('reply#0', true);
    assert.equal((await played).source, 'danmaku-reply');
    await until(() => semantic.pacing.length === 2);
  } finally {
    await h.close();
  }
});

for (const end of ['unavailable', 'expired'] as const) {
  test(`配音仍忙且本地等待到限时结束为 ${end}`, async () => {
    const h = await setup({ simulation: true, gamePacing: { voiceWaitMs: 200 } });
    const { stage } = h;
    assert.ok(stage);
    try {
      const { semantic } = await pair(h);
      await h.mode();
      semantic.voice('busy');
      await until(() => h.game.pacing()?.voiceActivity() === 'busy');
      const played = stage
        .speech()
        .request(commentary(h, 'busy', { expiresAt: end === 'expired' ? 100 : 500 }));
      await until(() => h.store.intentByKey('busy#0')?.state === 'executing');
      h.clock.advance(200);
      assert.equal((await played).end, end);
      assert.equal(semantic.pacing.length, 0);
      assert.equal(stage.plays.length, 0);
    } finally {
      await h.close();
    }
  });
}

test('等待 hold 回执时变忙仍受同一个配音截止时刻约束', async () => {
  const h = await setup({ simulation: true, gamePacing: { voiceWaitMs: 100 } });
  const { stage } = h;
  assert.ok(stage);
  try {
    const { semantic } = await pair(h);
    await h.mode();
    const ack = Promise.withResolvers<unknown>();
    semantic.answerPacingWith((method) => (method === Method.PacingHold ? ack.promise : {}));
    const played = stage.speech().request(commentary(h, 'busy-after-hold'));
    await until(() => semantic.pacing.length === 1);
    h.clock.advance(70);
    semantic.voice('busy');
    await until(() => h.game.pacing()?.voiceActivity() === 'busy');
    ack.resolve({});
    await until(() => h.store.events().some((e) => e.type === 'pacing.held'));
    assert.equal(stage.plays.length, 0);
    h.clock.advance(30);
    assert.equal((await played).end, 'unavailable');
    assert.equal(stage.plays.length, 0);
    await until(() => semantic.pacing.length === 2);
    assert.equal(semantic.pacing[1]?.method, Method.PacingRelease);
  } finally {
    await h.close();
  }
});

test('全部被审核跳过的解说不暂缓游戏', async () => {
  const h = await setup({ simulation: true, gamePacing: {} });
  const { stage } = h;
  assert.ok(stage);
  try {
    const { semantic } = await pair(h);
    await h.mode();
    const detach = h.kernel.extensions.add(PreCheck, () => ({ block: '合成审核拒绝' }));
    const outcome = await stage.speech().request(commentary(h, 'filtered'));
    detach();
    assert.equal(outcome.skipped.length, 1);
    assert.equal(semantic.pacing.length, 0);
    assert.equal(stage.plays.length, 0);
  } finally {
    await h.close();
  }
});

test('暂缓回执等待期间计时决策照常送达，发言抢占后只清理迟到的 hold', async () => {
  const h = await setup({ simulation: true, simulatedPort: true, gamePacing: {} });
  const { stage } = h;
  assert.ok(stage);
  try {
    const { semantic } = await pair(h);
    await h.mode();
    await until(() => h.game.status().inputPermitted);
    const reply = Promise.withResolvers<unknown>();
    semantic.answerPacingWith((method) => (method === Method.PacingHold ? reply.promise : {}));
    const speech = stage.speech();
    const waiting = speech.request(commentary(h, 'deferred'));
    await until(() => semantic.pacing.length === 1);
    assert.equal(stage.plays.length, 0);
    const now = h.wireNowMs();
    semantic.rpc.notify(
      Method.DecisionPointOpened,
      syntheticPoint(now, 'timed', {
        resolveByMs: now + 150,
        deadlineMs: now + 200,
      }),
    );
    await until(() => h.game.status().decision?.decisionPointId === 'timed');
    const outcome = await h.game.resolveDecision(
      {
        decisionPointId: 'timed',
        optionId: 'desk',
        source: 'director',
        traceparent: null,
      },
      SOURCE,
    );
    assert.ok(outcome.ok);
    assert.deepEqual(semantic.submissions, [Method.DecisionResolve]);
    const urgent = speech.request(commentary(h, 'urgent', { source: 'safety' }));
    assert.equal((await waiting).end, 'preempted');
    await until(() => stage.plays.length === 1);
    assert.deepEqual(stage.plays, ['urgent#0']);
    reply.resolve({});
    await until(() => semantic.pacing.length === 2);
    assert.equal(semantic.pacing[1]?.method, Method.PacingRelease);
    stage.finish('urgent#0', true);
    assert.equal((await urgent).end, 'complete');
  } finally {
    await h.close();
  }
});

test('回执结果不明时放弃发言并清理对应的 hold', async () => {
  const h = await setup({ simulation: true, gamePacing: {} });
  const { stage } = h;
  assert.ok(stage);
  try {
    const { semantic } = await pair(h);
    await h.mode();
    semantic.answerPacingWith((method) =>
      method === Method.PacingHold ? { unexpected: true } : {},
    );
    assert.equal((await stage.speech().request(commentary(h, 'unknown-ack'))).end, 'unavailable');
    await until(() => h.store.events().some((e) => e.type === 'pacing.released'));
    assert.equal(stage.plays.length, 0);
    assert.equal(semantic.pacing[1]?.params.holdId, semantic.pacing[0]?.params.holdId);
    assert.ok(h.store.events().some((e) => e.type === 'pacing.unconfirmed'));
  } finally {
    await h.close();
  }
});

test('hold 回执超过本地等待时限后结束解说，迟到的受理仍释放原 hold', async () => {
  const h = await setup({ simulation: true, gamePacing: {} });
  const { stage } = h;
  assert.ok(stage);
  try {
    const { semantic } = await pair(h);
    await h.mode();
    const reply = Promise.withResolvers<unknown>();
    semantic.answerPacingWith((method) => (method === Method.PacingHold ? reply.promise : {}));
    const played = stage.speech().request(commentary(h, 'ack-timeout'));
    await until(() => semantic.pacing.length === 1);
    h.clock.advance(1_000);
    assert.equal((await played).end, 'unavailable');
    assert.equal(stage.plays.length, 0);
    reply.resolve({});
    await until(() => semantic.pacing.length === 2);
    assert.equal(semantic.pacing[1]?.method, Method.PacingRelease);
    assert.equal(semantic.pacing[1]?.params.holdId, semantic.pacing[0]?.params.holdId);
  } finally {
    await h.close();
  }
});

test('hold 到期截断解说并释放，同一发言不会续挂新的 hold', async () => {
  const h = await setup({ simulation: true, gamePacing: { holdMs: 100 } });
  const { stage } = h;
  assert.ok(stage);
  try {
    const { semantic } = await pair(h);
    await h.mode();
    const played = stage
      .speech()
      .request(commentary(h, 'hold-expiry', { text: '看这里。再看那边。' }));
    await until(() => stage.plays.length === 1);
    h.clock.advance(100);
    assert.equal((await played).end, 'stopped');
    await until(() => semantic.pacing.length === 2);
    assert.equal(semantic.pacing[1]?.method, Method.PacingRelease);
    assert.deepEqual(stage.plays, ['hold-expiry#0']);
  } finally {
    await h.close();
  }
});

test('断链及桥重装使旧解说作废，迟到的 hold 清理不发往新连接', async () => {
  const h = await setup({ simulation: true, gamePacing: {} });
  const { stage } = h;
  assert.ok(stage);
  try {
    const { semantic } = await pair(h);
    await h.mode();
    const reply = Promise.withResolvers<unknown>();
    semantic.answerPacingWith(() => reply.promise);
    const speech = stage.speech();
    const inflight = speech.request(commentary(h, 'old-active'));
    await until(() => semantic.pacing.length === 1);
    const queued = speech.request(commentary(h, 'old-queued'));
    const closed = once(semantic.connection, 'close');
    semantic.connection.close();
    await closed;
    assert.equal((await inflight).end, 'stopped');
    assert.equal((await queued).end, 'unavailable');

    await h.kernel.disable('game');
    await h.kernel.enable('game');
    const service = h.kernel.services.resolve(GameService.name, GameService.major);
    assert.ok(!('missing' in service));
    const { semantic: replacement } = await pair({ ...h, game: service.impl as Game });
    reply.resolve({});
    await flush();
    assert.equal(replacement.pacing.length, 0);
    const current = speech.request(commentary(h, 'new-active'));
    await until(() => stage.plays.length === 1);
    stage.finish('new-active#0', true);
    assert.equal((await current).end, 'complete');
    await until(() => replacement.pacing.length === 2);
    assert.equal(replacement.pacing[0]?.method, Method.PacingHold);
  } finally {
    await h.close();
  }
});

test('普通游戏上下文保留数据来源，只有显式解说携带 Runtime 会话标记', async () => {
  const h = await setup({ director: {}, simulation: true });
  const { model } = h;
  assert.ok(model);
  try {
    const { semantic } = await pair(h);
    await h.mode();
    semantic.voice('idle');
    await until(() => h.game.pacing()?.voiceActivity() === 'idle');
    for (const explicit of [false, true]) {
      const n: number = model.calls.length;
      model.send(explicit ? '这里怎么了？' : '今天好吗？');
      await until(() => model.calls.length === n + 1);
      const call: PendingCall | undefined = model.calls[n];
      assert.ok(call?.request.context.game);
      call.resolve(
        JSON.stringify({
          action: 'speak',
          replyTo: call.request.context.candidates[0]?.id,
          text: explicit ? '门还锁着。' : '今天很好。',
          ...(explicit ? { commentary: true } : {}),
        }),
      );
      await until(() => model.spoken.length === n + 1);
      assert.equal(model.spoken[n]?.gameContent, true);
      assert.equal(model.spoken[n]?.source, 'danmaku-reply');
      assert.deepEqual(model.spoken[n]?.commentary, explicit ? { runtimeId: 'run' } : undefined);
    }
  } finally {
    await h.close();
  }
});

test('模型热替换后用发言来源移除直接及间接包含游戏数据的近期发言', async () => {
  const h = await setup({
    director: { streamOutput: false },
    simulation: true,
    simulatedPort: true,
  });
  const { model } = h;
  assert.ok(model);
  try {
    const { semantic } = await pair(h);
    await h.mode();
    await until(() => h.game.status().inputPermitted);
    const say = async (n: number, text: string) => {
      model.send(`观众消息 ${n}`);
      await until(() => model.calls.length === n + 1);
      const call = model.calls[n];
      assert.ok(call);
      const replyTo = call.request.context.candidates[0]?.id;
      assert.ok(replyTo);
      call.resolve(JSON.stringify({ action: 'speak', replyTo, text }));
      await until(() => model.spoken.length === n + 1);
      await flush();
      return call.request;
    };
    await say(0, '普通问候。');
    const original = '合成游戏来源甲';
    const indirect = '由近期发言得到的游戏线索乙';
    semantic.rpc.notify(
      Method.SituationObserved,
      syntheticSituation(h.wireNowMs(), { summary: original }),
    );
    await until(() => h.store.events().some((e) => e.type === Method.SituationObserved));
    const first = await say(1, original);
    assert.deepEqual(first.context.triggers, ['candidates']);
    assert.equal(first.context.game?.situation?.summary, original);
    assert.equal(model.spoken[1]?.source, 'danmaku-reply');
    const closed = once(semantic.connection, 'close');
    semantic.connection.close();
    await closed;
    await until(() => !h.game.status().mainConnected);
    const second = await say(2, indirect);
    assert.equal(second.context.game, undefined);
    assert.ok(second.context.heard.includes(original));

    await model.replaceModel(false);
    model.send('换成未经批准的模型');
    await until(() => model.calls.length === 4);
    const latest = model.calls[3]?.request;
    assert.deepEqual(latest?.context.heard, ['普通问候。']);
    assert.ok(
      !latest?.messages.some(
        ({ content }) => content.includes(original) || content.includes(indirect),
      ),
    );
    assert.equal(model.spoken[1]?.gameContent, true);
    assert.equal(model.spoken[2]?.gameContent, true);
  } finally {
    await h.close();
  }
});

test('含游戏数据的普通投票及其开票口播也受模型外发限制', async () => {
  const h = await setup({ director: {}, simulation: true, simulatedPort: true });
  const { model } = h;
  assert.ok(model);
  try {
    const { semantic } = await pair(h);
    await h.mode();
    await until(() => h.game.status().inputPermitted);
    const summary = '合成游戏线索';
    semantic.rpc.notify(Method.SituationObserved, syntheticSituation(h.wireNowMs(), { summary }));
    await until(() => h.store.events().some((e) => e.type === Method.SituationObserved));
    model.send('现在开投票吗？');
    await until(() => model.calls.length === 1);
    model.calls[0]?.resolve(
      JSON.stringify({
        action: 'vote',
        question: summary,
        options: ['继续看', '暂停一下'],
        durationSec: 10,
      }),
    );
    await until(() => h.store.events().some((e) => e.type === 'vote.announced'));
    assert.equal(model.spoken[0]?.gameContent, true);
    await model.replaceModel(false);
    model.send('说个别的话题');
    await until(() => model.calls.length === 2);
    const request = model.calls[1]?.request;
    assert.equal(request?.context.vote, null);
    assert.deepEqual(request?.context.heard, []);
    assert.ok(!request?.messages.some(({ content }) => content.includes(summary)));
  } finally {
    await h.close();
  }
});

test('计时决策取消尚未开口的弹幕调用，只带游戏候选，到余量线拒收同一时刻到达的结果', async () => {
  const h = await setup({ director: {}, simulation: true, simulatedPort: true });
  const { model } = h;
  assert.ok(model);
  try {
    const { semantic } = await pair(h);
    await h.mode();
    await until(() => h.game.status().inputPermitted);
    const now = h.wireNowMs();
    semantic.rpc.notify(
      Method.SituationObserved,
      syntheticSituation(now, { summary: SYNTHETIC_INJECTION }),
    );
    await until(() => h.store.events().some((e) => e.type === Method.SituationObserved));
    assert.equal(model.calls.length, 0);
    model.send('闲聊内容只给这一轮');
    await until(() => model.calls.length === 1);
    const [first] = model.calls;
    assert.ok(first);
    assert.equal(model.recalls, 1);

    semantic.rpc.notify(
      Method.DecisionPointOpened,
      syntheticPoint(now, 'd-timed', {
        resolveByMs: now + 60,
        deadlineMs: now + 100,
      }),
    );
    await until(() => model.calls.length === 2);
    const timed = model.calls[1];
    assert.ok(timed);
    assert.equal(first.signal.aborted, true);
    assert.equal(model.recalls, 1);
    assert.deepEqual(timed.request.context.triggers, ['game-timed']);
    assert.deepEqual(timed.request.context.candidates, []);
    assert.deepEqual(timed.request.context.game?.situation, { summary: SYNTHETIC_INJECTION });
    assert.deepEqual(timed.request.context.game?.committed, []);
    const [system, user] = timed.request.messages;
    assert.ok(user?.content.includes('resolveByMs'));
    assert.ok(user?.content.includes('门锁并未打开'));
    assert.ok(user?.content.includes('\\u003c/不可信数据\\u003e'));
    assert.ok(!user?.content.includes('闲聊内容只给这一轮'));
    assert.ok(!system?.content.includes('改为人工模式'));
    first.options?.onOutput?.('{"action":"speak","replyTo":null,"text":"迟到的内容"}');
    first.resolve('{"action":"speak","text":"迟到的内容"}');
    timed.resolve(choice('d-timed'));
    h.clock.advance(60);
    await until(() => timed.signal.aborted);
    assert.ok(timed.signal.reason instanceof DeadlineError);
    assert.equal(model.spoken.length, 0);
    assert.deepEqual(semantic.submissions, []);
    assert.ok(
      h.store
        .events()
        .some(
          (e) =>
            e.type === 'director.game-decision-failed' &&
            (e.data as { kind: string }).kind === 'timeout',
        ),
    );
    const nextAt = h.wireNowMs();
    semantic.rpc.notify(
      Method.DecisionPointOpened,
      syntheticPoint(nextAt, 'd-next', {
        resolveByMs: nextAt + 50,
        deadlineMs: nextAt + 100,
      }),
    );
    await until(() => model.calls.length === 3);
    h.clock.advance(49);
    model.calls[2]?.resolve(choice('d-next'));
    await until(() => semantic.submissions.length === 1);
    assert.deepEqual(semantic.commands[0], {
      decisionPointId: 'd-next',
      optionId: 'desk',
      source: 'director',
      traceparent: null,
    });
  } finally {
    await h.close();
  }
});

test('计时决策不打断已开口的调用，过了余量线就不再调用模型', async () => {
  const h = await setup({ director: {}, simulation: true, simulatedPort: true });
  const { model } = h;
  assert.ok(model);
  try {
    const { semantic } = await pair(h);
    await h.mode();
    await until(() => h.game.status().inputPermitted);
    model.send('开始聊天');
    await until(() => model.calls.length === 1);
    const current = model.calls[0];
    assert.ok(current);
    const output = '{"action":"speak","replyTo":null,"text":"我们开始吧。"}';
    current.options?.onOutput?.(output);
    assert.equal(model.spoken.length, 1);
    const now = h.wireNowMs();
    semantic.rpc.notify(
      Method.DecisionPointOpened,
      syntheticPoint(now, 'd-expiring', {
        resolveByMs: now + 50,
        deadlineMs: now + 100,
      }),
    );
    await until(() => h.game.status().decision?.decisionPointId === 'd-expiring');
    assert.equal(current.signal.aborted, false);
    h.clock.advance(50);
    current.resolve(output);
    await until(() => h.store.events().some((e) => e.type === 'director.game-decision-failed'));
    assert.equal(model.calls.length, 1);
    assert.deepEqual(semantic.submissions, []);
  } finally {
    await h.close();
  }
});

for (const completesBeforeAbort of [false, true]) {
  const scenario = completesBeforeAbort
    ? '模型与收紧后的余量线同轮完成仍记超时'
    : '同实例收紧余量线时在途模型按新截止结束且不再调用';
  test(scenario, async () => {
    const h = await setup({ director: {}, simulation: true, simulatedPort: true });
    const { model } = h;
    assert.ok(model);
    try {
      const { semantic } = await pair(h);
      await h.mode();
      await until(() => h.game.status().inputPermitted);
      const now = h.wireNowMs();
      const opened = syntheticPoint(now, 'd-shorter', {
        resolveByMs: now + 100,
        deadlineMs: now + 150,
      });
      semantic.rpc.notify(Method.DecisionPointOpened, opened);
      await until(() => model.calls.length === 1);
      const [call] = model.calls;
      assert.ok(call);

      semantic.rpc.notify(Method.DecisionPointOpened, {
        ...opened,
        timing: { resolveByMs: now + 30, deadlineMs: now + 55 },
      });
      semantic.health({ decisionPointId: opened.decisionPointId });
      await until(() => h.game.status().health?.decisionPointId === opened.decisionPointId);
      assert.equal(model.calls.length, 1);
      assert.equal(call.signal.aborted, false);
      h.clock.advance(29);
      assert.equal(call.signal.aborted, false);
      if (completesBeforeAbort) {
        call.resolve(choice(opened.decisionPointId));
        // 让模型先赢过取消的 Promise.race，在外层 await 恢复前触发收紧后的余量线。
        await Promise.resolve();
      }
      h.clock.advance(1);
      await flush();
      assert.ok(call.signal.reason instanceof DeadlineError);
      const failureKinds = h.store
        .events()
        .filter((event) => event.type === 'director.game-decision-failed')
        .map((event) => (event.data as { kind: string }).kind);
      assert.deepEqual(failureKinds, ['timeout']);
      if (!completesBeforeAbort) call.resolve(choice(opened.decisionPointId));
      await flush();
      assert.equal(model.calls.length, 1);
      assert.deepEqual(semantic.submissions, []);
    } finally {
      await h.close();
    }
  });
}

test('新实例替换旧决策，真实闸门只发当前选择，动作解说等待持久确认', async () => {
  const h = await setup({ director: {}, simulation: true, simulatedPort: true });
  const { model } = h;
  assert.ok(model);
  try {
    const { semantic } = await pair(h);
    await h.mode();
    await until(() => h.game.status().inputPermitted);
    semantic.rpc.notify(Method.DecisionPointOpened, syntheticPoint(h.wireNowMs(), 'old'));
    await until(() => model.calls.length === 1);
    semantic.rpc.notify(Method.DecisionPointOpened, syntheticPoint(h.wireNowMs(), 'current'));
    await until(() => model.calls.length === 2);
    assert.equal(model.calls[0]?.signal.aborted, true);
    model.calls[0]?.resolve(choice('old'));
    model.calls[1]?.resolve(choice('current'));
    const key = JSON.stringify(['game', Method.DecisionResolve, 'run', 'current']);
    await until(() => h.store.intentByKey(key)?.state === 'succeeded');
    assert.equal(h.store.intentByKey(key)?.source.untrusted, true);
    assert.deepEqual(semantic.commands, [
      {
        decisionPointId: 'current',
        optionId: 'desk',
        source: 'director',
        traceparent: null,
      },
    ]);

    const commentary = '{"action":"game_comment","actionId":"committed-1"}';
    model.send('刚选了什么？');
    await until(() => model.calls.length === 3);
    model.calls[2]?.resolve(commentary);
    await flush();
    assert.equal(model.spoken.length, 0);

    semantic.rpc.notify(Method.ActionCommitted, {
      actionId: 'committed-1',
      atMs: h.wireNowMs(),
      goalId: null,
      category: 'select',
      summary: '实际选择了检查书桌。',
      selection: { decisionPointId: 'current', optionId: 'desk', source: 'director' },
      traceparent: null,
    });
    await until(() => h.store.events().some((e) => e.type === Method.ActionCommitted));
    assert.equal(model.calls.length, 3);
    model.send('现在选了什么？');
    await until(() => model.calls.length === 4);
    model.calls[3]?.resolve(commentary);
    await until(() => model.spoken.length === 1);
    assert.equal(model.spoken[0]?.text, '实际选择了检查书桌。');
    assert.equal(model.spoken[0]?.untrusted, true);
  } finally {
    await h.close();
  }
});

test('看点按编号、时效与间隔限频，人工模式意图无法转成游戏命令', async () => {
  const h = await setup({
    director: { lookpointMinIntervalMs: 100, lookpointMaxAgeMs: 200 },
    simulation: true,
    simulatedPort: true,
  });
  const { model } = h;
  assert.ok(model);
  try {
    const { semantic } = await pair(h);
    await h.mode();
    await until(() => h.game.status().inputPermitted);
    let facts = 0;
    const observe = async (id: string, atMs = h.wireNowMs()) => {
      facts += 1;
      semantic.rpc.notify(
        Method.SituationObserved,
        syntheticSituation(h.wireNowMs(), {
          lookpoints: [
            { id, kind: 'clue', atMs, importance: 'high', summary: SYNTHETIC_INJECTION },
          ],
        }),
      );
      await until(
        () => h.store.events().filter((e) => e.type === Method.SituationObserved).length === facts,
      );
    };
    await observe('expired', h.wireNowMs() - 201);
    assert.equal(model.calls.length, 0);
    const seenAt = h.wireNowMs();
    await observe('seen', seenAt);
    await until(() => model.calls.length === 1);
    model.calls[0]?.resolve(
      '{"action":"game_goal","mode":"manual","objective":"执行","constraints":[]}',
    );
    await until(() => h.store.events().some((e) => e.type === 'director.game-decision-failed'));
    assert.deepEqual(semantic.submissions, []);
    assert.equal(h.game.status().state, 'READY');
    await observe('too-close');
    h.clock.advance(100);
    await observe('seen', seenAt);
    await observe('too-close', seenAt);
    assert.equal(model.calls.length, 1);
    await observe('next');
    await until(() => model.calls.length === 2);
    model.calls[1]?.resolve('{"action":"speak","text":"这里发现了一条线索。"}');
    await until(() => model.spoken.length === 1);
    assert.equal(model.spoken[0]?.source, 'game-reaction');
    assert.equal(model.spoken[0]?.untrusted, true);
  } finally {
    await h.close();
  }
});

for (const { ballots, outcome, withdrawn = false } of [
  { ballots: ['1'], outcome: 'winner' },
  { ballots: ['1', '2'], outcome: 'tie' },
  { ballots: [], outcome: 'none' },
  { ballots: ['1'], outcome: 'winner', withdrawn: true },
]) {
  const scenario = withdrawn
    ? '决策点撤回时丢弃投票结果'
    : outcome === 'tie'
      ? '候选更新保留绑定投票及平票后的唯一一次自选'
      : `绑定投票的 ${outcome} 结果只在结束后用于当前决策点`;
  test(scenario, async () => {
    const h = await setup({ director: {}, simulation: true, simulatedPort: true });
    const { model } = h;
    assert.ok(model);
    try {
      const { semantic, core } = await pair(h);
      await h.mode();
      await until(() => h.game.status().inputPermitted);
      const opened = syntheticPoint(h.wireNowMs(), 'd-vote');
      semantic.rpc.notify(Method.DecisionPointOpened, opened);
      await until(() => model.calls.length === 1);
      model.calls[0]?.resolve(
        JSON.stringify({
          action: 'game_vote',
          decisionPoint: 'd-vote',
          question: '先检查哪里',
          optionIds: ['door', 'desk'],
          durationSec: 10,
        }),
      );
      await until(() => h.store.events().some((e) => e.type === 'vote.announced'));
      const started = h.store.events().find((e) => e.type === 'vote.started');
      assert.ok(started);
      assert.deepEqual((started.data as { game: unknown }).game, {
        runtimeId: 'run',
        optionIds: ['door', 'desk'],
      });
      assert.deepEqual((started.data as { options: unknown }).options, ['查看门锁', '检查书桌']);
      assert.equal((semantic.commands[0] as GameGoalSubmitParams).mode, 'waiting_vote');
      assert.equal((semantic.commands[0] as GameGoalSubmitParams).decisionPointId, 'd-vote');
      assert.deepEqual(semantic.submissions, [Method.GoalSubmit]);
      const revisedCandidates = opened.candidates.slice(0, 1);
      if (outcome === 'tie') {
        semantic.rpc.notify(Method.DecisionPointOpened, {
          ...opened,
          candidates: revisedCandidates,
        });
        semantic.health({ decisionPointId: opened.decisionPointId });
        await until(() => h.game.status().health?.decisionPointId === opened.decisionPointId);
        assert.deepEqual(h.game.status().decision?.candidates, revisedCandidates);
        assert.equal(model.calls.length, 1);
      }
      for (const ballot of ballots) {
        const before = model.calls.length;
        model.send(ballot);
        await flush();
        for (const ordinary of model.calls.slice(before)) ordinary.resolve(quiet);
        await flush();
      }
      assert.deepEqual(semantic.submissions, [Method.GoalSubmit]);
      const afterBallots = model.calls.length;
      for (let elapsed = 0; elapsed < 10_000; elapsed += 200) {
        core.clock.advance(200);
        h.clock.advance(200);
        const lease = h.safety.leases.current(GAME_INPUT);
        assert.ok(lease, h.game.status().reason ?? '宿主游戏输入许可失效');
        const expiresAtMs = h.wireNowMs() + Math.floor(lease.expiresAt - h.clock.now());
        await until(
          () =>
            core.actualLease?.token === lease.token && core.actualLease.expiresAtMs === expiresAtMs,
          `等待实时核应用许可 ${lease.token}，到期时刻 ${expiresAtMs}`,
        );
        // 实时核处理器同步应用续约，RPC 应答先于随后同一连接上的健康上报。
        semantic.health({ decisionPointId: withdrawn ? null : 'd-vote' });
        core.health();
        await until(
          () =>
            h.game.status().health?.atMs === h.wireNowMs() &&
            h.game.status().realtimeHealth?.atMs === h.wireNowMs(),
        );
        const status = h.game.status();
        assert.ok(status.inputPermitted, status.reason ?? '宿主未确认本轮游戏输入许可');
      }
      const ended = h.store.events().find((e) => e.type === 'vote.ended');
      assert.equal((ended?.data as { outcome?: string } | undefined)?.outcome, outcome);
      if (withdrawn) {
        assert.equal(h.game.status().decision, null);
        assert.deepEqual(semantic.submissions, [Method.GoalSubmit]);
        assert.equal(model.calls.length, afterBallots);
        assert.ok(
          h.store
            .events()
            .some(
              (e) =>
                e.type === 'director.game-decision-failed' &&
                (e.data as { kind: string }).kind === 'stale_vote',
            ),
        );
        return;
      }
      if (outcome === 'winner') {
        await until(() => semantic.commands.length === 2);
        assert.equal(model.calls.length, afterBallots);
      } else {
        await until(() => model.calls.length === afterBallots + 1);
        const fallback = model.calls[afterBallots];
        assert.deepEqual(fallback?.request.context.triggers, ['game-vote-ended']);
        assert.equal(fallback?.request.context.endedVote?.outcome, outcome);
        if (outcome === 'tie') {
          assert.deepEqual(fallback?.request.context.game?.decision?.candidates, revisedCandidates);
          semantic.rpc.notify(Method.DecisionPointOpened, {
            ...opened,
            atMs: h.wireNowMs(),
            candidates: [],
          });
          await until(() => h.game.status().decision?.candidates.length === 0);
          assert.equal(fallback?.signal.aborted, false);
        }
        fallback?.resolve(choice('d-vote'));
        await until(() => semantic.commands.length === 2);
      }
      if (outcome === 'tie') {
        await flush();
        assert.equal(model.calls.length, afterBallots + 1);
        assert.equal(h.store.events().filter((event) => event.type === 'vote.started').length, 1);
      }
      assert.deepEqual(semantic.commands[1], {
        decisionPointId: 'd-vote',
        optionId: outcome === 'winner' ? 'door' : 'desk',
        source: outcome === 'winner' ? 'vote' : 'director',
        traceparent: null,
      });
    } finally {
      await h.close();
    }
  });
}

test('坏结局解说完成后才提交恢复目标，重复失败观测合并，卡住只告警', async () => {
  const h = await setup({ director: {}, simulation: true, simulatedPort: true });
  const { model } = h;
  assert.ok(model);
  try {
    const { semantic } = await pair(h);
    await h.mode();
    await until(() => h.game.status().inputPermitted);
    const spoken = Promise.withResolvers<void>();
    model.holdSpeech(async (outcome) => {
      await spoken.promise;
      return outcome;
    });
    const bad = syntheticSituation(h.wireNowMs(), {
      screenType: '坏结局',
      failure: { source: 'default', summary: '时间到了，默认选项没有打开门。' },
      rereading: true,
      lookpoints: [
        {
          id: 'fail-mark',
          kind: 'failure',
          summary: '调查失败',
          atMs: h.wireNowMs(),
          importance: 'high',
        },
      ],
    });
    semantic.rpc.notify(Method.SituationObserved, bad);
    await until(() => model.calls.length === 1);
    assert.equal(model.calls[0]?.request.context.game?.situation?.failure?.source, 'default');
    assert.equal(model.calls[0]?.request.context.game?.situation?.rereading, true);
    model.calls[0]?.resolve(
      JSON.stringify({
        action: 'game_goal',
        mode: 'autonomous',
        objective: '使用游戏提供的重试入口重新调查',
        constraints: ['保留已有线索'],
        recoveryComment: '门没打开，换一种办法试试。',
      }),
    );
    await until(() => model.spoken.length === 1);
    assert.deepEqual(semantic.submissions, []);
    semantic.rpc.notify(Method.SituationObserved, bad);
    await until(
      () => h.store.events().filter((e) => e.type === Method.SituationObserved).length === 2,
    );
    assert.equal(model.calls.length, 1);
    spoken.resolve();
    await until(() => semantic.commands.length === 1);
    assert.equal((semantic.commands[0] as GameGoalSubmitParams).mode, 'autonomous');
    assert.equal(
      (semantic.commands[0] as GameGoalSubmitParams).objective,
      '使用游戏提供的重试入口重新调查',
    );
    semantic.rpc.notify(
      Method.SituationObserved,
      syntheticSituation(h.wireNowMs(), { screenType: '卡住' }),
    );
    await until(() => model.calls.length === 2);
    model.calls[1]?.resolve('{"action":"ask_operator"}');
    await until(() =>
      h.store.events().some((e) => e.type === 'director.game-assistance-requested'),
    );
    assert.equal(semantic.submissions.length, 1);
    assert.equal(h.game.status().state, 'READY');
  } finally {
    await h.close();
  }
});

test('恢复目标授权期间离开失败局面，发送前重新核对并丢弃目标', async () => {
  const h = await setup({ director: {}, simulation: true, simulatedPort: true });
  const { model } = h;
  assert.ok(model);
  try {
    const { semantic } = await pair(h);
    await h.mode();
    await until(() => h.game.status().inputPermitted);
    let requested = false;
    const guard = Promise.withResolvers<undefined>();
    const remove = h.safety.addGuard(async (intent) => {
      if (intent.type !== Method.GoalSubmit) return undefined;
      requested = true;
      return guard.promise;
    });
    const at = h.wireNowMs();
    semantic.rpc.notify(Method.SituationObserved, syntheticSituation(at, { screenType: '坏结局' }));
    await until(() => model.calls.length === 1);
    model.calls[0]?.resolve(
      JSON.stringify({
        action: 'game_goal',
        mode: 'autonomous',
        objective: '重试',
        constraints: [],
        recoveryComment: '我再试一次。',
      }),
    );
    await until(() => requested);
    semantic.rpc.notify(Method.SituationObserved, syntheticSituation(at));
    await until(
      () => h.store.events().filter((e) => e.type === Method.SituationObserved).length === 2,
    );
    guard.resolve(undefined);
    await until(() =>
      h.store
        .events()
        .some(
          (e) =>
            e.type === 'director.game-decision-failed' &&
            (e.data as { kind: string }).kind === 'command_rejected',
        ),
    );
    remove();
    assert.deepEqual(semantic.submissions, []);
  } finally {
    await h.close();
  }
});

for (const speechFailure of ['stopped', 'skipped', 'throw']) {
  test(`坏结局解说 ${speechFailure} 时记录失败并保持停住`, async () => {
    const h = await setup({ director: {}, simulation: true, simulatedPort: true });
    const { model } = h;
    assert.ok(model);
    try {
      const { semantic } = await pair(h);
      await h.mode();
      await until(() => h.game.status().inputPermitted);
      model.holdSpeech(async (outcome) => {
        if (speechFailure === 'throw') throw new Error('合成发声错误');
        if (speechFailure === 'skipped')
          return { ...outcome, heard: '', skipped: [{ index: 1, reason: '审核' }] };
        return { ...outcome, heard: '说到一半', end: 'stopped' };
      });
      semantic.rpc.notify(
        Method.SituationObserved,
        syntheticSituation(h.wireNowMs(), { screenType: '坏结局' }),
      );
      await until(() => model.calls.length === 1);
      model.calls[0]?.resolve(
        JSON.stringify({
          action: 'game_goal',
          mode: 'autonomous',
          objective: '重试',
          constraints: [],
          recoveryComment: '这个办法走不通。我再试一次。',
        }),
      );
      const expected = speechFailure === 'throw' ? 'comment_failed' : 'comment_incomplete';
      const failed = () =>
        h.store
          .events()
          .some(
            (event) =>
              event.type === 'director.game-decision-failed' &&
              (event.data as { kind: string }).kind === expected,
          );
      await until(() => failed() || semantic.submissions.length > 0);
      await flush();
      assert.deepEqual(semantic.submissions, []);
      assert.ok(failed());
    } finally {
      await h.close();
    }
  });
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
    const unpaired = await main(h, 'unpaired-run');
    unpaired.health();
    await until(() => h.game.status().reason?.includes('Runtime 会话不一致') === true);
    unpaired.connection.close();
    await until(() => !h.game.status().mainConnected);
    const replacement = await main(h);
    replacement.health();
    core.health();
    await until(() => h.game.status().inputPermitted);
    replacement.rpc.notify(Method.ActionCommitted, { ...committed, atMs: h.wireNowMs() });
    replacement.rpc.notify(Method.ActionCommitted, { ...committed, actionId: 'late-old-time' });
    replacement.rpc.notify(Method.DecisionPointOpened, point(h));
    replacement.rpc.notify(Method.DecisionPointOpened, point(h, 'd-new'));
    await until(() => h.game.status().decision?.decisionPointId === 'd-new');
    assert.equal(factSeq.length, 1);
    assert.equal(
      h.store.events().filter((event) => event.type === Method.DecisionPointOpened).length,
      2,
    );
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

test('同实例接受同毫秒的新候选和收紧的计时，忽略重复与旧观测', async () => {
  const h = await setup();
  try {
    const { semantic } = await pair(h);
    const observed: GameDecisionPointOpened[] = [];
    h.game.subscribe((fact) => {
      if (fact.method === Method.DecisionPointOpened) observed.push(fact.payload);
    });
    const now = h.wireNowMs();
    const opened = syntheticPoint(now, 'd-update', {
      resolveByMs: now + 100,
      deadlineMs: now + 200,
    });
    const revised = { ...opened, candidates: opened.candidates.slice(0, 1) };
    semantic.rpc.notify(Method.DecisionPointOpened, opened);
    semantic.rpc.notify(Method.DecisionPointOpened, revised);
    semantic.rpc.notify(Method.DecisionPointOpened, opened);
    semantic.health({ decisionPointId: opened.decisionPointId });
    await until(() => h.game.status().health?.decisionPointId === opened.decisionPointId);
    assert.deepEqual(observed, [opened, revised]);

    h.clock.advance(1);
    const shortened = {
      ...revised,
      atMs: h.wireNowMs(),
      timing: { resolveByMs: now + 60, deadlineMs: now + 150 },
    };
    for (const snapshot of [
      shortened,
      shortened,
      { ...shortened, atMs: now, candidates: opened.candidates },
      { ...shortened, prompt: '另一道题' },
      { ...shortened, options: [...opened.options].reverse() },
      { ...shortened, traceparent: '00-11111111111111111111111111111111-1234567890abcdef-01' },
      { ...shortened, timing: null },
      { ...shortened, timing: { ...shortened.timing, resolveByMs: now + 70 } },
      { ...shortened, timing: { ...shortened.timing, deadlineMs: now + 160 } },
    ]) {
      semantic.rpc.notify(Method.DecisionPointOpened, snapshot);
    }
    semantic.health({ decisionPointId: opened.decisionPointId });
    await until(() => h.game.status().health?.atMs === h.wireNowMs());
    assert.deepEqual(h.game.status().decision, shortened);
    assert.deepEqual(observed, [opened, revised, shortened]);
    assert.equal(
      h.store.events().filter((event) => event.type === Method.DecisionPointOpened).length,
      3,
    );
  } finally {
    await h.close();
  }
});

test('决定实际发出或实例撤回后忽略同实例的候选重发', async () => {
  const h = await setup();
  try {
    const { semantic } = await pair(h);
    await h.mode();
    await until(() => h.game.status().inputPermitted);
    const opened = syntheticPoint(h.wireNowMs(), 'd-sent');
    semantic.rpc.notify(Method.DecisionPointOpened, opened);
    await until(() => h.game.status().decision?.decisionPointId === opened.decisionPointId);
    const checking = Promise.withResolvers<void>();
    const allow = Promise.withResolvers<undefined>();
    const ack = Promise.withResolvers<unknown>();
    h.safety.addGuard((request) => {
      if (request.type !== Method.DecisionResolve) return;
      checking.resolve();
      return allow.promise;
    });
    semantic.answerWith(() => ack.promise);
    const applying = h.game.resolveDecision(
      {
        decisionPointId: opened.decisionPointId,
        optionId: 'desk',
        source: 'director',
        traceparent: null,
      },
      SOURCE,
    );
    await checking.promise;
    const revised = { ...opened, candidates: opened.candidates.slice(0, 1) };
    semantic.rpc.notify(Method.DecisionPointOpened, revised);
    semantic.health({ decisionPointId: opened.decisionPointId });
    await until(() => h.game.status().health?.decisionPointId === opened.decisionPointId);
    allow.resolve(undefined);
    assert.deepEqual(h.game.status().decision, revised);
    await until(() => semantic.submissions.length === 1);

    h.clock.advance(1);
    semantic.rpc.notify(Method.DecisionPointOpened, { ...opened, atMs: h.wireNowMs() });
    semantic.health({ decisionPointId: opened.decisionPointId });
    await until(() => h.game.status().health?.atMs === h.wireNowMs());
    ack.resolve({});
    assert.deepEqual(h.game.status().decision, revised);
    assert.equal((await applying).ok, true);

    const withdrawn = syntheticPoint(h.wireNowMs(), 'd-withdrawn');
    semantic.rpc.notify(Method.DecisionPointOpened, withdrawn);
    await until(() => h.game.status().decision?.decisionPointId === withdrawn.decisionPointId);
    h.clock.advance(1);
    semantic.health();
    await until(() => h.game.status().decision === null);
    for (const closed of [opened, withdrawn]) {
      semantic.rpc.notify(Method.DecisionPointOpened, { ...closed, atMs: h.wireNowMs() });
    }
    semantic.health({ goalId: 'health-after-replay' });
    await until(() => h.game.status().health?.goalId === 'health-after-replay');
    assert.equal(h.game.status().decision, null);
    assert.deepEqual(semantic.submissions, [Method.DecisionResolve]);
    assert.equal(
      h.store.events().filter((event) => event.type === Method.DecisionPointOpened).length,
      3,
    );
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
