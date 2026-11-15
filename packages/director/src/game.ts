import { createHash } from 'node:crypto';
import type { VoteEndedNotice } from '@bellis/audience';
import { type Game, type GameCommandResult, type GameFact, GameService } from '@bellis/game-bridge';
import type { PluginContext } from '@bellis/kernel';
import {
  type GameActionCommitted,
  GameBridgeRole,
  type GameDecisionPointOpened,
  type GameGoalSubmitParams,
  type GameSituationObserved,
} from '@bellis/protocol';
import type { SafetyFacade } from '@bellis/safety';

export type GameTrigger =
  | 'game-timed'
  | 'game-decision'
  | 'game-lookpoint'
  | 'game-failure'
  | 'game-vote-ended';

type Lookpoint = GameSituationObserved['lookpoints'][number];
type Fact<T> = { seq: number; data: T };
type FailureScreen = '坏结局' | '卡住';

export interface GameContext {
  situation:
    | (Pick<GameSituationObserved, 'summary'> &
        Partial<Omit<GameSituationObserved, 'summary' | 'traceparent' | 'lookpoints'>>)
    | null;
  decision: Omit<GameDecisionPointOpened, 'traceparent'> | null;
  lookpoint: Lookpoint | null;
  committed: Array<Omit<GameActionCommitted, 'traceparent'>>;
}

interface Session {
  game: Game;
  runtimeId: string;
  situation?: Fact<GameSituationObserved>;
  point?: Fact<GameDecisionPointOpened>;
  failure?: { seq: number; screen: FailureScreen };
  lookpoint?: Fact<Lookpoint>;
  seenLookpoints: Map<string, number>;
  committed: Array<Fact<GameActionCommitted>>;
  attemptedPoint?: string;
  endedVoteId?: string;
}

export interface GameTurn {
  game: Game;
  runtimeId: string;
  point: GameDecisionPointOpened | null;
  failure: Session['failure'];
  context: GameContext;
  inputs: string[];
  parent: string | undefined;
  triggers: GameTrigger[];
}

const isFailure = (screen: string): screen is FailureScreen =>
  screen === '坏结局' || screen === '卡住';

/** 游戏事实只活在当前的服务实例与运行会话。每次实际动作前用游戏桥的状态再核对。 */
export class DirectorGame {
  readonly #ctx: PluginContext;
  readonly #safety: SafetyFacade;
  readonly #minLookpointInterval: number;
  readonly #maxLookpointAge: number;
  #session: Session | undefined;
  #lastLookpointAt = -Infinity;
  #goals = 0;

  constructor(
    ctx: PluginContext,
    safety: SafetyFacade,
    config: { lookpointMinIntervalMs: number; lookpointMaxAgeMs: number },
  ) {
    this.#ctx = ctx;
    this.#safety = safety;
    this.#minLookpointInterval = config.lookpointMinIntervalMs;
    this.#maxLookpointAge = config.lookpointMaxAgeMs;
  }

  #current() {
    if (this.#ctx.signal.aborted) return;
    const game = this.#ctx.optional(GameService);
    if (!game) return;
    const status = game.status();
    const { runtimeId } = status;
    if (!runtimeId) return;
    if (this.#session?.game !== game || this.#session.runtimeId !== runtimeId) {
      this.#session = {
        game,
        runtimeId,
        seenLookpoints: new Map(),
        committed: [],
      };
    }
    return { state: this.#session, status };
  }

  observe(fact: GameFact): GameTrigger | undefined {
    const current = this.#current();
    if (!current || current.state.runtimeId !== fact.runtimeId || fact.role !== GameBridgeRole.Main)
      return;
    const { state, status } = current;
    if (fact.method === 'action.committed') {
      state.committed.push({ seq: fact.seq, data: fact.payload });
      if (state.committed.length > 8) state.committed.shift();
      return;
    }
    if (fact.method === 'decision_point.opened') {
      state.point = { seq: fact.seq, data: fact.payload };
      delete state.endedVoteId;
      if (status.state !== 'READY') return;
      if (fact.payload.timing && state.game.wireNowMs() >= fact.payload.timing.resolveByMs) {
        this.failed(state.runtimeId, fact.payload.decisionPointId, 'expired');
        return;
      }
      return fact.payload.timing ? 'game-timed' : 'game-decision';
    }
    if (fact.method !== 'situation.observed') return;
    const data = fact.payload;
    if (state.situation && data.atMs < state.situation.data.atMs) return;
    state.situation = { seq: fact.seq, data };
    let newFailure = false;
    if (isFailure(data.screenType)) {
      if (state.failure?.screen !== data.screenType) {
        state.failure = { seq: fact.seq, screen: data.screenType };
        newFailure = true;
      }
    } else {
      delete state.failure;
    }
    if (newFailure) delete state.lookpoint;
    const lookpoint = this.#lookpoint(
      state,
      fact.seq,
      data.lookpoints,
      status.state === 'READY' && !state.failure,
    );
    return status.state === 'READY' && newFailure ? 'game-failure' : lookpoint;
  }

  #lookpoint(
    state: Session,
    seq: number,
    marks: readonly Lookpoint[],
    eligible: boolean,
  ): GameTrigger | undefined {
    const now = state.game.wireNowMs();
    for (const [id, at] of state.seenLookpoints) {
      if (now - at > this.#maxLookpointAge) state.seenLookpoints.delete(id);
    }
    let found = false;
    for (const mark of marks) {
      if (now - mark.atMs > this.#maxLookpointAge || state.seenLookpoints.has(mark.id)) continue;
      state.seenLookpoints.set(mark.id, mark.atMs);
      if (!eligible || now - this.#lastLookpointAt < this.#minLookpointInterval) continue;
      if (
        !state.lookpoint ||
        mark.importance === 'high' ||
        state.lookpoint.data.importance !== 'high'
      ) {
        state.lookpoint = { seq, data: mark };
      }
      found = true;
    }
    if (found) return 'game-lookpoint';
  }

  capture(triggers: readonly GameTrigger[]): GameTurn | undefined {
    const current = this.#current();
    if (current?.status.state !== 'READY') return;
    const { state, status } = current;
    const point = status.decision;
    const now = state.game.wireNowMs();
    if (triggers.includes('game-timed') && (!point?.timing || point.timing.resolveByMs <= now)) {
      this.failed(
        state.runtimeId,
        state.point?.data.decisionPointId ?? null,
        point?.timing ? 'expired' : 'stale',
      );
      return;
    }
    const mark = triggers.includes('game-lookpoint') ? state.lookpoint : undefined;
    const lookpoint = mark && now - mark.data.atMs <= this.#maxLookpointAge ? mark : undefined;
    if (triggers.includes('game-lookpoint')) {
      delete state.lookpoint;
      if (lookpoint) this.#lastLookpointAt = now;
    }
    if (!state.situation && !point && state.committed.length === 0) return;
    const validTriggers = triggers.filter((trigger) => {
      if (trigger === 'game-decision') return !!point && !point.timing;
      if (trigger === 'game-failure') return !!state.failure;
      if (trigger === 'game-lookpoint') return !!lookpoint;
      return true;
    });
    const situation = state.situation && gameSituationContext(state.situation.data);
    const decision = point && gameDecisionContext(point);
    const pointSeq =
      state.point?.data.decisionPointId === point?.decisionPointId ? state.point?.seq : undefined;
    const seqs = [
      state.situation?.seq,
      pointSeq,
      lookpoint?.seq,
      ...state.committed.map(({ seq }) => seq),
    ];
    return {
      game: state.game,
      runtimeId: state.runtimeId,
      point,
      failure: state.failure,
      context: {
        situation: situation ?? null,
        decision,
        lookpoint: lookpoint?.data ?? null,
        committed: state.committed.map(({ data: { traceparent: _trace, ...data } }) => data),
      },
      inputs: [...new Set(seqs.flatMap((seq) => (seq === undefined ? [] : [`game:${seq}`])))],
      parent: point?.traceparent ?? state.situation?.data.traceparent ?? undefined,
      triggers: validTriggers,
    };
  }

  isCurrent(turn: GameTurn): boolean {
    const current = this.#current();
    return (
      !!current &&
      current.state.game === turn.game &&
      current.state.runtimeId === turn.runtimeId &&
      current.status.state === 'READY' &&
      current.status.decision?.decisionPointId === turn.point?.decisionPointId &&
      (!turn.failure || current.state.failure?.seq === turn.failure.seq)
    );
  }

  voteEnded(notice: VoteEndedNotice): GameTurn | undefined {
    if (!notice.game) return;
    const turn = this.capture([]);
    const state = this.#session;
    if (
      !state ||
      !turn?.point ||
      turn.point.timing ||
      turn.runtimeId !== notice.game.runtimeId ||
      turn.point.decisionPointId !== notice.decisionPoint
    ) {
      this.failed(notice.game.runtimeId, notice.decisionPoint, 'stale_vote');
      return;
    }
    if (state.endedVoteId === notice.voteId) return;
    state.endedVoteId = notice.voteId;
    return turn;
  }

  attempted(turn: GameTurn): boolean {
    return turn.point !== null && this.#session?.attemptedPoint === turn.point.decisionPointId;
  }

  async choose(
    turn: GameTurn,
    optionId: string,
    source: 'director' | 'vote',
    traceparent: string | null,
    extraInputs: readonly string[],
  ): Promise<void> {
    const { point, game, runtimeId } = turn;
    const state = this.#session;
    if (!state || !point || !this.isCurrent(turn) || this.attempted(turn)) return;
    if (point.timing && game.wireNowMs() >= point.timing.resolveByMs) {
      this.failed(runtimeId, point.decisionPointId, 'expired');
      return;
    }
    if (!point.options.some(({ id }) => id === optionId)) {
      this.failed(runtimeId, point.decisionPointId, 'invalid_option');
      return;
    }
    state.attemptedPoint = point.decisionPointId;
    await this.#command(turn, 'decision.resolve', () =>
      game.resolveDecision(
        {
          decisionPointId: point.decisionPointId,
          optionId,
          source,
          traceparent,
        },
        { origin: source, inputs: [...turn.inputs, ...extraInputs], untrusted: true },
        () => this.isCurrent(turn),
      ),
    );
  }

  async goal(
    turn: GameTurn,
    goal: Pick<GameGoalSubmitParams, 'objective' | 'constraints' | 'mode' | 'decisionPointId'>,
    ttlMs: number,
    traceparent: string | null,
    extraInputs: readonly string[],
  ): Promise<boolean> {
    if (!this.isCurrent(turn) || this.attempted(turn)) {
      this.failed(turn.runtimeId, turn.point?.decisionPointId ?? null, 'stale', 'goal.submit');
      return false;
    }
    const now = turn.game.wireNowMs();
    const goalId = createHash('sha256')
      .update(JSON.stringify([this.#ctx.instanceId, turn.runtimeId, now, ++this.#goals]))
      .digest('hex');
    return this.#command(turn, 'goal.submit', () =>
      turn.game.submitGoal(
        {
          ...goal,
          goalId,
          expiresAtMs: now + ttlMs,
          traceparent,
        },
        { origin: 'director', inputs: [...turn.inputs, ...extraInputs], untrusted: true },
        () => this.isCurrent(turn),
      ),
    );
  }

  async #command(
    turn: GameTurn,
    method: 'goal.submit' | 'decision.resolve',
    send: () => Promise<GameCommandResult>,
  ): Promise<boolean> {
    let result: GameCommandResult;
    try {
      result = await send();
    } catch {
      this.failed(turn.runtimeId, turn.point?.decisionPointId ?? null, 'command_failed', method);
      return false;
    }
    if (!result.ok) {
      this.failed(
        turn.runtimeId,
        turn.point?.decisionPointId ?? null,
        result.intent?.state === 'unknown' ? 'unknown_outcome' : 'command_rejected',
        method,
      );
    }
    return result.ok;
  }

  failed(runtimeId: string, decisionPoint: string | null, kind: string, method?: string): void {
    const fields = { runtimeId, decisionPoint, kind, ...(method ? { method } : {}) };
    this.#ctx.log('director.game-decision-failed', fields);
    this.#safety.record('director.game-decision-failed', fields);
  }
}

function gameSituationContext({
  traceparent: _trace,
  lookpoints: _marks,
  ...data
}: GameSituationObserved) {
  return data;
}

function gameDecisionContext({ traceparent: _trace, ...data }: GameDecisionPointOpened) {
  return data;
}
