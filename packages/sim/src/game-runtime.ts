import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { Connection, createSessionKey, RpcError, RpcPeer } from '@bellis/channel';
import type { TimerHandle } from '@bellis/kernel';
import {
  checkGameBridgeMessage,
  GAME_BRIDGE_MAJOR,
  GAME_LEASE_REFUSED,
  type GameActionCommitted,
  type GameCoreHealth,
  type GameDecisionPointOpened,
  type GameDecisionResolveParams,
  type GameGoalSubmitParams,
  type GameInputReleased,
  type GameInputStopParams,
  type GameLeaseRenewParams,
  type GamePacingHoldParams,
  type GamePacingReleaseParams,
  type GameScreenType,
  GameBridgeMethod as Method,
  GameBridgeRole as Role,
  RpcErrorCode,
  type RpcParams,
} from '@bellis/protocol';
import type { World } from './world.ts';

export const GAME_ADAPTER = { id: 'synthetic-game', version: '1', screenTypes: [] };
const RUNTIME_ID = 'sim-runtime';
const OPTIONS = [
  { id: 'a', label: '查看书桌' },
  { id: 'b', label: '查看门锁' },
];
const PREREQUISITES = [{ id: 'display', text: '模拟显示面已就绪', confirmed: true }];
const HEALTH_INTERVAL_MS = 250;

export type GameCue = { atMs: number } & (
  | { action: 'decision'; id: string; timingMs?: number; rankedOptions?: string[] }
  | { action: 'decision-candidates'; id: string; rankedOptions: string[] }
  | { action: 'situation'; screen: GameScreenType; lookpoint?: string }
  | { action: 'goal'; id: string }
  | { action: 'advance' | 'takeover' | 'disconnect' | 'stall' | 'hold-reply' }
);

function rankedCandidates(optionIds: readonly string[]): GameDecisionPointOpened['candidates'] {
  return optionIds.map((optionId, index) => ({
    optionId,
    rank: index + 1,
    reason: '有可调查的线索',
    citation: null,
    previousFailure: null,
  }));
}

/** 异步交付字节，保留通道的认证、帧解析、请求取消与断开行为。 */
function loopback(): [Socket, Socket] {
  const ends: Duplex[] = [];
  for (const index of [0, 1]) {
    const other = () => ends[1 - index];
    ends.push(
      new Duplex({
        read() {},
        write(chunk: Buffer, _encoding, complete) {
          queueMicrotask(() => {
            other()?.push(chunk);
            complete();
          });
        },
        final(complete) {
          queueMicrotask(() => {
            other()?.push(null);
            complete();
          });
        },
        destroy(error, complete) {
          queueMicrotask(() => {
            other()?.destroy();
            complete(error);
          });
        },
      }),
    );
  }
  // Connection 只使用 Duplex 的事件、write、end 与 destroy。
  return ends as [Socket, Socket];
}

/** 按正式控制契约收许可，设备证据来自本地的模拟持键账目。 */
export class SimGameRuntime {
  #world!: World;
  #main: RpcPeer | undefined;
  #core: RpcPeer | undefined;
  #lease: GameLeaseRenewParams | undefined;
  #leaseState: GameCoreHealth['leaseState'] = 'not_granted';
  #lastToken = 0;
  #leaseTimer: TimerHandle | undefined;
  #goal: GameGoalSubmitParams | undefined;
  #waitingVote: GameGoalSubmitParams | undefined;
  #decision: GameDecisionPointOpened | undefined;
  #actionId = 0;
  #held = new Set<GameActionCommitted['category']>();
  #holds = new Map<string, number>();
  #advancePending = false;
  #holdReply = false;
  #nextHealth = 0;
  readonly #loseRelease: boolean;

  constructor(loseRelease: boolean) {
    this.#loseRelease = loseRelease;
  }

  get now(): number {
    return Math.floor(this.#world.clock.now());
  }

  /** 在宿主 I/O 未排空的一次时钟推进中跨过当前许可截止。 */
  get remainingLease(): number {
    return Math.max(0, (this.#lease?.expiresAtMs ?? this.now) - this.now);
  }

  async attach(world: World): Promise<void> {
    this.#world = world;
    this.#leaseState = 'not_granted';
    this.#nextHealth = this.now;
    this.#main = await this.#peer(Role.Main, (peer) => {
      peer.handle(Method.Describe, () => ({
        major: GAME_BRIDGE_MAJOR,
        runtimeId: RUNTIME_ID,
        nowMs: this.now,
        adapter: GAME_ADAPTER,
        prerequisites: PREREQUISITES,
      }));
      peer.handle(Method.GoalSubmit, (raw, { signal }) =>
        this.#acceptGoal(raw as GameGoalSubmitParams, signal),
      );
      peer.handle(Method.DecisionResolve, (raw) => this.#resolve(raw as GameDecisionResolveParams));
      peer.handle(Method.PacingHold, (raw) => this.#hold(raw as GamePacingHoldParams));
      peer.handle(Method.PacingRelease, (raw) => {
        if (this.#loseRelease) throw new RpcError(RpcErrorCode.ServerBusy, '模拟解除失败');
        this.#endHold((raw as GamePacingReleaseParams).holdId, 'release');
        return {};
      });
    });
    this.#core = await this.#peer(Role.Core, (peer) => {
      peer.handle(Method.Describe, () => ({
        major: GAME_BRIDGE_MAJOR,
        runtimeId: RUNTIME_ID,
        nowMs: this.now,
      }));
      peer.handle(Method.LeaseRenew, (raw) => this.#renew(raw as GameLeaseRenewParams));
      peer.handle(Method.InputStop, (raw) => {
        const { throughToken } = raw as GameInputStopParams;
        if ((this.#lease?.token ?? 0) <= throughToken) {
          this.#lastToken = Math.max(this.#lastToken, throughToken);
          this.#release('lease_revoked', throughToken || null);
        }
        return {};
      });
    });
    await world.flush();
    this.report();
    await world.flush();
    if (this.#decision) {
      if (this.#decision.timing && this.now >= this.#decision.timing.resolveByMs)
        this.#decision = undefined;
      else {
        this.#publishDecision(this.#decision);
        this.#armDecision(this.#decision);
      }
    }
  }

  async #peer(role: Role, setup: (peer: RpcPeer) => void): Promise<RpcPeer> {
    const host = this.#world.gameHost;
    if (!host) throw new Error('仿真没有提供游戏桥端口');
    const [server, client] = loopback();
    const options = { key: createSessionKey() };
    const [incoming, connection] = await Promise.all([
      Connection.accept(server, options),
      Connection.open(client, role, options),
    ]);
    const peer = new RpcPeer(connection, {
      timeoutMs: 2_000,
      acceptIncoming: (message) =>
        checkGameBridgeMessage(role, 'bellis', message) ||
        (typeof message === 'object' &&
          message !== null &&
          'method' in message &&
          message.method === 'rpc.cancel'),
    });
    setup(peer);
    host.accept(incoming);
    return peer;
  }

  report(): void {
    for (const [id, expires] of this.#holds) {
      if (this.now >= expires) this.#endHold(id, 'expired');
    }
    if (this.now < this.#nextHealth) return;
    this.#nextHealth = this.now + HEALTH_INTERVAL_MS;
    const active = this.#waitingVote ?? this.#currentGoal();
    this.#notify(this.#main, Method.HealthReported, {
      atMs: this.now,
      ready: true,
      prerequisites: PREREQUISITES,
      mode: active?.mode ?? 'paused',
      goalId: active?.goalId ?? null,
      decisionPointId: this.#decision?.decisionPointId ?? null,
      firstActionMs: null,
      frameAgeMs: 0,
      queueDepth: 0,
      riskScore: 0,
      riskLimitExceeded: false,
      lastRejection: null,
    });
    this.#notify(this.#core, Method.HealthReported, {
      atMs: this.now,
      leaseState: this.#leaseState,
      frameAgeMs: 0,
      queueDepth: 0,
    });
  }

  #notify(peer: RpcPeer | undefined, method: string, payload: RpcParams): void {
    if (peer?.connection.isOpen) peer.notify(method, payload);
  }

  #renew(lease: GameLeaseRenewParams): object {
    if (this.#lease && this.now >= this.#lease.expiresAtMs) this.#release('lease_expired');
    if (
      lease.expiresAtMs <= this.now ||
      (lease.token <= this.#lastToken && lease.token !== this.#lease?.token)
    ) {
      throw new RpcError(GAME_LEASE_REFUSED, '模拟输入许可已失效');
    }
    if (this.#lease && this.#lease.token !== lease.token) this.#release('lease_revoked');
    this.#clearLeaseTimer();
    this.#lease = lease;
    this.#lastToken = lease.token;
    this.#leaseState = 'valid';
    this.#world.record('game.lease', { ...lease });
    this.#leaseTimer = this.#world.clock.setTimeout(() => {
      this.#release('lease_expired');
    }, lease.expiresAtMs - this.now);
    return {};
  }

  #clearLeaseTimer(): void {
    if (this.#leaseTimer) this.#world.clock.clearTimeout(this.#leaseTimer);
    this.#leaseTimer = undefined;
  }

  #release(reason: GameInputReleased['reason'], token = this.#lease?.token ?? null): void {
    this.#clearLeaseTimer();
    this.#lease = undefined;
    this.#goal = undefined;
    this.#waitingVote = undefined;
    this.#advancePending = false;
    this.#leaseState =
      reason === 'lease_source_lost'
        ? 'source_lost'
        : reason === 'lease_expired'
          ? 'expired'
          : 'revoked';
    this.#releaseInputs(reason, token);
  }

  #releaseInputs(reason: GameInputReleased['reason'], token: number | null): void {
    const held = [...this.#held];
    for (const key of held) this.#held.delete(key);
    const release: GameInputReleased = {
      atMs: this.now,
      token,
      reason,
      verification: this.#held.size === 0 ? 'verified' : 'residual',
    };
    this.#world.record('game.device-release', { ...release, held, remaining: [...this.#held] });
    this.#notify(this.#core, Method.InputReleased, release);
  }

  disconnect(): void {
    this.#core?.connection.destroy();
    this.#core = undefined;
    this.#release('lease_source_lost');
  }

  /** 进程外设备在宿主消失时得知断线，保留已观察的决策实例。 */
  hostLost(): void {
    this.#world.record('game.host-lost', {
      token: this.#lease?.token ?? null,
      decisionPointId: this.#decision?.decisionPointId ?? null,
    });
    this.disconnect();
    this.#main?.connection.destroy();
    this.#main = undefined;
  }

  dispose(): void {
    this.#core?.connection.destroy();
    this.#main?.connection.destroy();
  }

  takeOver(): void {
    this.#release('takeover');
  }

  holdReply(): void {
    this.#holdReply = true;
  }

  #acceptGoal(goal: GameGoalSubmitParams, signal: AbortSignal): object {
    const vote = goal.mode === 'waiting_vote';
    const refused =
      goal.expiresAtMs <= this.now ||
      goal.mode === 'manual' ||
      (vote &&
        (!this.#decision ||
          this.#decision.timing !== null ||
          goal.decisionPointId !== this.#decision.decisionPointId ||
          this.#currentGoal()?.mode !== 'autonomous'));
    this.#world.record('game.goal', {
      runtimeId: RUNTIME_ID,
      ...goal,
      accepted: !refused,
    });
    if (refused) throw new RpcError(RpcErrorCode.InvalidParams, '模拟目标已过期或与当前决策不符');
    if (vote) this.#waitingVote = goal;
    else {
      this.#goal = goal;
      this.#waitingVote = undefined;
    }
    this.#world.clock.setTimeout(() => {
      if (this.#goal !== goal && this.#waitingVote !== goal) return;
      this.#goal = undefined;
      this.#waitingVote = undefined;
      this.#advancePending = false;
      this.#world.record('game.goal-expired', { goalId: goal.goalId });
      if (this.#held.size > 0) this.#releaseInputs('deadline_expired', this.#lease?.token ?? null);
    }, goal.expiresAtMs - this.now);
    if (!this.#holdReply) return {};
    this.#holdReply = false;
    this.#world.record('game.goal-reply-held', { goalId: goal.goalId });
    // 命令已收到，连接一直保持到宿主崩溃。RPC 不会先收到错误或超时回执。
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }

  #currentGoal(): GameGoalSubmitParams | undefined {
    return this.#goal && this.#goal.expiresAtMs > this.now ? this.#goal : undefined;
  }

  openDecision(id: string, timingMs?: number, rankedOptions = ['a']): void {
    this.#setDecision({
      decisionPointId: id,
      atMs: this.now,
      prompt: '先调查哪处？',
      options: OPTIONS,
      candidates: rankedCandidates(rankedOptions),
      timing:
        timingMs === undefined
          ? null
          : { resolveByMs: this.now + timingMs, deadlineMs: this.now + timingMs + 100 },
      traceparent: null,
    });
  }

  updateCandidates(id: string, rankedOptions: readonly string[]): void {
    const current = this.#decision;
    if (current?.decisionPointId !== id) return;
    this.#setDecision({ ...current, atMs: this.now, candidates: rankedCandidates(rankedOptions) });
  }

  #setDecision(point: GameDecisionPointOpened): void {
    this.#decision = point;
    this.#publishDecision(point);
    this.#armDecision(point);
  }

  #publishDecision(point: GameDecisionPointOpened): void {
    // 计时快照须有候选。候选耗尽时保留本机计时，只记录设备观察到的变化。
    if (point.timing && point.candidates.length === 0) {
      this.#world.record('game.candidates-unavailable', {
        runtimeId: RUNTIME_ID,
        decisionPointId: point.decisionPointId,
      });
      return;
    }
    this.#notify(this.#main, Method.DecisionPointOpened, { ...point, atMs: this.now });
  }

  #armDecision(point: GameDecisionPointOpened): void {
    const timing = point.timing;
    if (!timing) return;
    this.#world.clock.setTimeout(() => {
      if (this.#decision !== point) return;
      const first = point.candidates.find(({ rank }) => rank === 1);
      if (first && this.now < timing.deadlineMs)
        this.#select(point, first.optionId, 'default', null);
      this.#decision = undefined;
    }, timing.resolveByMs - this.now);
  }

  #resolve(decision: GameDecisionResolveParams): object {
    this.#world.record('game.resolve', { runtimeId: RUNTIME_ID, ...decision });
    const point = this.#decision;
    if (
      !point ||
      point.decisionPointId !== decision.decisionPointId ||
      (point.timing && (decision.source === 'vote' || this.now >= point.timing.resolveByMs)) ||
      !this.#select(point, decision.optionId, decision.source, decision.traceparent)
    ) {
      throw new RpcError(RpcErrorCode.InvalidParams, '模拟决定已失效');
    }
    this.#decision = undefined;
    return {};
  }

  #select(
    point: GameDecisionPointOpened,
    optionId: string,
    source: 'director' | 'vote' | 'default',
    traceparent: string | null,
  ): boolean {
    const root = this.#currentGoal();
    const vote = this.#waitingVote;
    if (
      root?.mode !== 'autonomous' ||
      !point.options.some(({ id }) => id === optionId) ||
      (vote && (vote.decisionPointId !== point.decisionPointId || vote.expiresAtMs <= this.now)) ||
      (source === 'vote' && !vote)
    )
      return false;
    const applied = this.#input(
      'select',
      vote ?? root,
      { decisionPointId: point.decisionPointId, optionId, source },
      traceparent,
    );
    if (applied) this.#waitingVote = undefined;
    return applied;
  }

  situation(screenType: GameScreenType, lookpoint?: string): void {
    this.#notify(this.#main, Method.SituationObserved, {
      atMs: this.now,
      screenType,
      screenTypeExtension: null,
      summary: '模拟调查现场',
      currentLine: null,
      interactables: [],
      voiceActivity: 'idle',
      rereading: false,
      failure:
        screenType === '坏结局' || screenType === '卡住'
          ? { summary: '模拟推进停止', source: null }
          : null,
      lookpoints: lookpoint
        ? [
            {
              id: lookpoint,
              kind: 'clue',
              summary: '发现模拟线索',
              importance: 'high',
              atMs: this.now,
            },
          ]
        : [],
      traceparent: null,
    });
  }

  advance(): void {
    this.#advancePending = true;
    this.#tryAdvance();
  }

  #tryAdvance(): void {
    if (!this.#advancePending || this.#decision || this.#waitingVote) return;
    const goal = this.#currentGoal();
    if (goal?.mode !== 'autonomous') {
      this.#advancePending = false;
      this.#world.record('game.advance-denied', { goalId: this.#goal?.goalId ?? null });
      return;
    }
    if ([...this.#holds.values()].some((expiry) => expiry > this.now)) {
      this.#world.record('game.advance-held', {});
      return;
    }
    this.#advancePending = false;
    this.#input('advance', goal, null, goal.traceparent);
  }

  #input(
    category: GameActionCommitted['category'],
    goal: GameGoalSubmitParams,
    selection: GameActionCommitted['selection'],
    traceparent: string | null,
  ): boolean {
    const lease = this.#lease;
    if (!lease || !this.#core?.connection.isOpen || this.now >= lease.expiresAtMs) return false;
    const actionId = `a${++this.#actionId}`;
    this.#held.add(category);
    const goalId = goal.goalId;
    const committed: GameActionCommitted = {
      actionId,
      atMs: this.now,
      goalId,
      category,
      summary: '模拟游戏推进了一步。',
      selection,
      traceparent,
    };
    this.#world.record('game.input', { runtimeId: RUNTIME_ID, token: lease.token, ...committed });
    this.#notify(this.#main, Method.ActionCommitted, committed);
    return true;
  }

  #hold(hold: GamePacingHoldParams): object {
    this.#holds.set(hold.holdId, hold.expiresAtMs);
    this.#world.record('game.hold', { ...hold });
    this.#world.clock.setTimeout(() => {
      if (this.#holds.get(hold.holdId) === hold.expiresAtMs) this.#endHold(hold.holdId, 'expired');
    }, hold.expiresAtMs - this.now);
    return {};
  }

  #endHold(holdId: string, reason: 'expired' | 'release'): void {
    if (!this.#holds.delete(holdId)) return;
    this.#world.record('game.hold-end', { holdId, reason });
    this.#tryAdvance();
  }
}
