import { defineService } from '@bellis/kernel';
import type {
  GameActionCommitted,
  GameBridgeRole,
  GameCoreHealth,
  GameDecisionPointOpened,
  GameDecisionResolveParams,
  GameGoalSubmitParams,
  GameInputReleased,
  GameMainDescription,
  GameMainHealth,
  GameSituationObserved,
} from '@bellis/protocol';
import type { Intent, IntentSource, Projection } from '@bellis/store';

export const GAME_GOAL = 'game.goal';
export const GAME_INPUT = 'game.input';

export const GameControlFact = {
  Taken: 'game.control-taken',
  Returned: 'game.control-returned',
} as const;

export const gameControlLedger: Projection<Readonly<Record<string, string>>> = {
  name: 'game.control',
  initial: {},
  reduce(state, event) {
    if (event.type === GameControlFact.Taken) {
      const { target, reason } = event.data as { target: string; reason: string };
      return { ...state, [target]: reason };
    }
    if (event.type === GameControlFact.Returned) {
      const next = { ...state };
      delete next[(event.data as { target: string }).target];
      return next;
    }
    return state;
  },
};

export interface GameStatus {
  state: 'WAITING' | 'READY' | 'MANUAL';
  reason: string | null;
  mainConnected: boolean;
  coreConnected: boolean;
  runtimeId: string | null;
  adapter: GameMainDescription['adapter'] | null;
  health: GameMainHealth | null;
  realtimeHealth: GameCoreHealth | null;
  decision: GameDecisionPointOpened | null;
  inputPermitted: boolean;
}

export type GameEvent =
  | { method: 'situation.observed'; payload: GameSituationObserved }
  | { method: 'decision_point.opened'; payload: GameDecisionPointOpened }
  | { method: 'action.committed'; payload: GameActionCommitted }
  | { method: 'input.released'; payload: GameInputReleased }
  | { method: 'health.reported'; payload: GameMainHealth | GameCoreHealth };

export type GameFact = GameEvent & {
  seq: number;
  role: GameBridgeRole;
  runtimeId: string;
};

export type GameCommandResult =
  | { ok: true; intent: Intent; duplicate: boolean }
  | { ok: false; reason: string; intent?: Intent };

export interface Game {
  status(): GameStatus;
  /** 与局面时刻和截止时间同域，仿真使用注入的单调时钟。 */
  wireNowMs(): number;
  /** 回调只接收已经写入状态存储的事实。 */
  subscribe(listener: (fact: GameFact) => void): () => void;
  submitGoal(params: GameGoalSubmitParams, source: IntentSource): Promise<GameCommandResult>;
  resolveDecision(
    params: GameDecisionResolveParams,
    source: IntentSource,
  ): Promise<GameCommandResult>;
}

export const GameService = defineService<Game>('game', 1);
