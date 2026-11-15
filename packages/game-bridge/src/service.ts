import { defineExtension, defineService } from '@bellis/kernel';
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

/** 与 game@1 的订阅同源，供可选依赖在桥晚于自己加载或热替换时继续观察。 */
export const GameFactObserved = defineExtension<'observe', GameFact>(
  'game.fact-observed',
  'observe',
);

export type GameCommandResult =
  | { ok: true; intent: Intent; duplicate: boolean }
  | { ok: false; reason: string; intent?: Intent };

export interface GamePacingHold {
  readonly accepted: Promise<boolean>;
  remainingMs(): number;
  release(): void;
}

/** 暂缓推进与配音状态绑在同一次已认证的语义连接。 */
export interface GamePacing {
  readonly signal: AbortSignal;
  voiceActivity(): GameSituationObserved['voiceActivity'];
  subscribeVoice(listener: () => void): () => void;
  hold(ttlMs: number, traceparent: string | null): GamePacingHold | undefined;
}

export interface Game {
  status(): GameStatus;
  /** 与局面时刻和截止时间同域，仿真使用注入的单调时钟。 */
  wireNowMs(): number;
  /** 回调只接收已经写入状态存储的事实。 */
  subscribe(listener: (fact: GameFact) => void): () => void;
  pacing(runtimeId?: string): GamePacing | undefined;
  /** 可在发送前追加本机判断。闸门仍独立授权，判断失败时不发命令。 */
  submitGoal(
    params: GameGoalSubmitParams,
    source: IntentSource,
    stillValid?: () => boolean,
  ): Promise<GameCommandResult>;
  resolveDecision(
    params: GameDecisionResolveParams,
    source: IntentSource,
    stillValid?: () => boolean,
  ): Promise<GameCommandResult>;
}

export const GameService = defineService<Game>('game', 1);
