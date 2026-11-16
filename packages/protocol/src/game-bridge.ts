import Type, { type Static, type TSchema } from 'typebox';
import { Traceparent } from './telemetry.ts';

const closed = { additionalProperties: false } as const;
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const instanceId = Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$' });
const adapterId = Type.String({ pattern: '^[a-z][a-z0-9-]{0,47}$' });
const count = Type.Integer({ minimum: 0, maximum: 0xffff_ffff });
const token = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const traceparent = nullable(Traceparent);

/** 系统单调时钟的整毫秒；上界乘 1_000_000 后仍是 Rust u64 纳秒。 */
const monotonicMs = Type.Integer({ minimum: 0, maximum: 18_446_744_073_709 });

export const GAME_BRIDGE_MAJOR = 1;
export const GAME_BRIDGE_SEMANTIC_V2 = 2;
export type GameBridgeMajor = typeof GAME_BRIDGE_MAJOR | typeof GAME_BRIDGE_SEMANTIC_V2;

/** v1 在线上须使用整数字面量的字段，包含 JSON-RPC 的请求编号和错误码。 */
export const GAME_BRIDGE_INTEGER_FIELDS = [
  'id',
  'code',
  'major',
  'nowMs',
  'atMs',
  'expiresAtMs',
  'resolveByMs',
  'deadlineMs',
  'token',
  'throughToken',
  'rank',
  'firstActionMs',
  'frameAgeMs',
  'queueDepth',
] as const;

export const GameBridgeRole = {
  Main: 'game-runtime.main',
  Core: 'game-runtime.core',
} as const;
export type GameBridgeRole = (typeof GameBridgeRole)[keyof typeof GameBridgeRole];

export const GameBridgeMethod = {
  Describe: 'game.describe',
  TaskOpen: 'task.open',
  ActionResolveOutcome: 'action.resolve_outcome',
  GoalSubmit: 'goal.submit',
  DecisionResolve: 'decision.resolve',
  LeaseRenew: 'lease.renew',
  InputStop: 'input.stop',
  PacingHold: 'pacing.hold',
  PacingRelease: 'pacing.release',
  SituationObserved: 'situation.observed',
  DecisionPointOpened: 'decision_point.opened',
  ActionCommitted: 'action.committed',
  InputReleased: 'input.released',
  HealthReported: 'health.reported',
} as const;

/** 过期、过低、吊销过的令牌等被实时核拒绝（同 Runtime 核协议）。 */
export const GAME_LEASE_REFUSED = -32004;

/** 同 Runtime adapter 的 ScreenType；扩展单独声明名称和所属的通用类型。 */
export const GameScreenType = Type.Enum([
  '对话',
  '选择',
  '计时选择',
  '菜单',
  '设置',
  '存读档',
  '商店',
  '加载',
  '过场',
  '即时玩法',
  '地图',
  '背包',
  '坏结局',
  '卡住',
  '未知',
]);
export type GameScreenType = Static<typeof GameScreenType>;

const GameMode = Type.Enum(['autonomous', 'waiting_vote', 'paused', 'manual']);
const GameDecisionSource = Type.Enum(['director', 'vote']);
const GameSelectionSource = Type.Enum(['director', 'vote', 'default']);
const GamePrerequisite = Type.Object(
  { id: adapterId, text: text(240), confirmed: Type.Boolean() },
  closed,
);
const prerequisites = Type.Array(GamePrerequisite, { maxItems: 64 });
const extensionName = text(80);
const GameScreenTypeExtension = Type.Object({ name: extensionName, base: GameScreenType }, closed);
const GameFailure = Type.Object(
  { source: nullable(GameSelectionSource), summary: text(240) },
  closed,
);
const GameSelection = Type.Object(
  { decisionPointId: instanceId, optionId: instanceId, source: GameSelectionSource },
  closed,
);
const GameLookpoint = Type.Object(
  {
    id: instanceId,
    kind: adapterId,
    summary: text(240),
    importance: Type.Enum(['medium', 'high']),
    atMs: monotonicMs,
  },
  closed,
);
const GameDecisionOption = Type.Object({ id: instanceId, label: text(240) }, closed);
const GameDecisionCandidate = Type.Object(
  {
    optionId: instanceId,
    rank: Type.Integer({ minimum: 1, maximum: 64 }),
    reason: text(240),
    citation: nullable(text(120)),
    previousFailure: nullable(GameFailure),
  },
  closed,
);

// 各主版本共用 major。应答先读开放结构里的 major，再按对应版本核对整份描述。
const major = Type.Integer({ minimum: 1, maximum: 0xffff });
const description = { major, runtimeId: instanceId, nowMs: monotonicMs };

export const GameDescribeVersion = Type.Object({ major });

export const GameDescribeParams = Type.Object({ major }, closed);
export type GameDescribeParams = Static<typeof GameDescribeParams>;

export const GameMainDescription = Type.Object(
  {
    ...description,
    adapter: Type.Object(
      {
        id: adapterId,
        version: text(32),
        screenTypes: Type.Array(GameScreenTypeExtension, { maxItems: 64 }),
      },
      closed,
    ),
    prerequisites,
  },
  closed,
);
export type GameMainDescription = Static<typeof GameMainDescription>;

export const GameCoreDescription = Type.Object(description, closed);
export type GameCoreDescription = Static<typeof GameCoreDescription>;

export const GameAck = Type.Object({}, closed);

export const GameGoalSubmitParams = Type.Object(
  {
    goalId: instanceId,
    objective: text(600),
    constraints: Type.Array(text(160), { maxItems: 16 }),
    mode: GameMode,
    decisionPointId: nullable(instanceId),
    expiresAtMs: monotonicMs,
    traceparent,
  },
  closed,
);
export type GameGoalSubmitParams = Static<typeof GameGoalSubmitParams>;

export const GameDecisionResolveParams = Type.Object(
  { decisionPointId: instanceId, optionId: instanceId, source: GameDecisionSource, traceparent },
  closed,
);
export type GameDecisionResolveParams = Static<typeof GameDecisionResolveParams>;

export const GameLeaseRenewParams = Type.Object({ token, expiresAtMs: monotonicMs }, closed);
export type GameLeaseRenewParams = Static<typeof GameLeaseRenewParams>;

export const GameInputStopParams = Type.Object(
  {
    throughToken: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    reason: text(200),
  },
  closed,
);
export type GameInputStopParams = Static<typeof GameInputStopParams>;

export const GamePacingHoldParams = Type.Object(
  { holdId: instanceId, reason: text(200), expiresAtMs: monotonicMs, traceparent },
  closed,
);
export type GamePacingHoldParams = Static<typeof GamePacingHoldParams>;

export const GamePacingReleaseParams = Type.Object({ holdId: instanceId, traceparent }, closed);
export type GamePacingReleaseParams = Static<typeof GamePacingReleaseParams>;

export const GameSituationObserved = Type.Object(
  {
    atMs: monotonicMs,
    screenType: GameScreenType,
    screenTypeExtension: nullable(extensionName),
    summary: text(600),
    currentLine: nullable(text(240)),
    interactables: Type.Array(text(160), { maxItems: 32 }),
    lookpoints: Type.Array(GameLookpoint, { maxItems: 16 }),
    voiceActivity: Type.Enum(['busy', 'idle', 'unknown']),
    rereading: Type.Boolean(),
    failure: nullable(GameFailure),
    traceparent,
  },
  closed,
);
export type GameSituationObserved = Static<typeof GameSituationObserved>;

export const GameDecisionPointOpened = Type.Object(
  {
    decisionPointId: instanceId,
    atMs: monotonicMs,
    prompt: text(360),
    options: Type.Array(GameDecisionOption, { minItems: 1, maxItems: 64 }),
    candidates: Type.Array(GameDecisionCandidate, { maxItems: 64 }),
    timing: nullable(Type.Object({ resolveByMs: monotonicMs, deadlineMs: monotonicMs }, closed)),
    traceparent,
  },
  closed,
);
export type GameDecisionPointOpened = Static<typeof GameDecisionPointOpened>;

export const GameActionCommitted = Type.Object(
  {
    actionId: instanceId,
    atMs: monotonicMs,
    goalId: nullable(instanceId),
    category: Type.Enum(['advance', 'navigate', 'select']),
    summary: text(240),
    selection: nullable(GameSelection),
    traceparent,
  },
  closed,
);
export type GameActionCommitted = Static<typeof GameActionCommitted>;

export const GameInputReleased = Type.Object(
  {
    token: nullable(token),
    atMs: monotonicMs,
    reason: Type.Enum([
      'core_start',
      'generation_revoked',
      'producer_changed',
      'heartbeat_timeout',
      'deadline_expired',
      'frame_stale',
      'lease_expired',
      'lease_revoked',
      'lease_source_lost',
      'no_lease',
      'focus_lost',
      'takeover',
      'emergency_stop',
      'injection_blocked',
      'hook_lost',
      'max_hold',
      'stop',
      'core_connection_lost',
      'stdin_closed',
    ]),
    verification: Type.Enum(['verified', 'residual', 'unverified']),
  },
  closed,
);
export type GameInputReleased = Static<typeof GameInputReleased>;

export const GameMainHealth = Type.Object(
  {
    atMs: monotonicMs,
    ready: Type.Boolean(),
    mode: GameMode,
    goalId: nullable(instanceId),
    decisionPointId: nullable(instanceId),
    prerequisites,
    firstActionMs: nullable(count),
    frameAgeMs: nullable(count),
    queueDepth: count,
    riskScore: Type.Number({ minimum: 0, maximum: 1 }),
    riskLimitExceeded: Type.Boolean(),
    lastRejection: nullable(
      Type.Object({ atMs: monotonicMs, code: adapterId, summary: text(200) }, closed),
    ),
  },
  closed,
);
export type GameMainHealth = Static<typeof GameMainHealth>;

export const GameCoreHealth = Type.Object(
  {
    atMs: monotonicMs,
    leaseState: Type.Enum(['not_granted', 'valid', 'expired', 'revoked', 'source_lost']),
    frameAgeMs: nullable(count),
    queueDepth: count,
  },
  closed,
);
export type GameCoreHealth = Static<typeof GameCoreHealth>;

/** 可信配置中的被控槽位标识，生命周期独立于 Runtime 进程。 */
export const GameControlTargetId = instanceId;

export const GameMainDescriptionV2 = Type.Object(
  {
    ...GameMainDescription.properties,
    major: Type.Integer({ minimum: GAME_BRIDGE_SEMANTIC_V2, maximum: GAME_BRIDGE_SEMANTIC_V2 }),
    controlTargetId: GameControlTargetId,
  },
  closed,
);
export type GameMainDescriptionV2 = Static<typeof GameMainDescriptionV2>;

export const GamePendingActionOutcome = Type.Object(
  {
    attemptId: instanceId,
    runtimeId: instanceId,
    sessionId: instanceId,
    goalId: instanceId,
    actionId: instanceId,
    decisionPointId: nullable(instanceId),
    reason: text(200),
  },
  closed,
);
export type GamePendingActionOutcome = Static<typeof GamePendingActionOutcome>;

export const GameMainHealthV2 = Type.Object(
  {
    ...GameMainHealth.properties,
    pendingActionOutcome: nullable(GamePendingActionOutcome),
    activeTaskId: nullable(instanceId),
  },
  {
    ...closed,
    not: { properties: { pendingActionOutcome: { type: 'object' }, ready: { const: true } } },
  },
);
export type GameMainHealthV2 = Static<typeof GameMainHealthV2>;

export const GameOutcomeResolution = Type.Enum([
  'confirmed_executed',
  'confirmed_not_executed',
  'reconciled_unknown',
]);
export type GameOutcomeResolution = Static<typeof GameOutcomeResolution>;

export const GameActionResolveOutcomeParams = Type.Object(
  { sessionId: instanceId, attemptId: instanceId, resolution: GameOutcomeResolution },
  closed,
);
export type GameActionResolveOutcomeParams = Static<typeof GameActionResolveOutcomeParams>;

export const GameActionResolveOutcomeResult = Type.Object(
  { attemptId: instanceId, resolution: GameOutcomeResolution },
  closed,
);

export const GameOverallCompletion = Type.Union([
  Type.Object({ kind: Type.Enum(['signature']), signature: text(120) }, closed),
  Type.Object({ kind: Type.Enum(['screen']), screenType: GameScreenType }, closed),
  Type.Object(
    { kind: Type.Enum(['text-appeared', 'text-disappeared']), text: text(240), roi: text(80) },
    closed,
  ),
]);
export type GameOverallCompletion = Static<typeof GameOverallCompletion>;

export const GameTaskOpenParams = Type.Object(
  {
    taskId: instanceId,
    objective: GameGoalSubmitParams.properties.objective,
    expiresAtMs: monotonicMs,
    overallCompletion: nullable(GameOverallCompletion),
  },
  closed,
);
export type GameTaskOpenParams = Static<typeof GameTaskOpenParams>;

export const GameTaskOpenResult = Type.Object({ taskId: instanceId }, closed);

export const GameGoalSubmitParamsV2 = Type.Object(
  { ...GameGoalSubmitParams.properties, taskId: instanceId },
  closed,
);

export const gameBridgeSchemas = {
  GameDescribeVersion,
  GameDescribeParams,
  GameMainDescription,
  GameCoreDescription,
  GameAck,
  GameGoalSubmitParams,
  GameDecisionResolveParams,
  GameLeaseRenewParams,
  GameInputStopParams,
  GamePacingHoldParams,
  GamePacingReleaseParams,
  GameSituationObserved,
  GameDecisionPointOpened,
  GameActionCommitted,
  GameInputReleased,
  GameMainHealth,
  GameCoreHealth,
} as const;

export type GameBridgeSender = 'bellis' | 'runtime';
export type GameBridgeSchemaName =
  | keyof typeof gameBridgeSchemas
  | keyof typeof gameBridgeV2Schemas;

export interface GameBridgeMethodSpec {
  readonly sender: GameBridgeSender;
  readonly params: GameBridgeSchemaName;
  /** null 表示通知。其它方法须以 JSON-RPC 请求发送。 */
  readonly result: GameBridgeSchemaName | null;
}

/** 随 Schema 分发的角色、方向与载荷表，字段值是 $defs 下的名字。 */
export const GameBridgeMethods = {
  [GameBridgeRole.Main]: {
    [GameBridgeMethod.Describe]: {
      sender: 'bellis',
      params: 'GameDescribeParams',
      result: 'GameMainDescription',
    },
    [GameBridgeMethod.GoalSubmit]: {
      sender: 'bellis',
      params: 'GameGoalSubmitParams',
      result: 'GameAck',
    },
    [GameBridgeMethod.DecisionResolve]: {
      sender: 'bellis',
      params: 'GameDecisionResolveParams',
      result: 'GameAck',
    },
    [GameBridgeMethod.PacingHold]: {
      sender: 'bellis',
      params: 'GamePacingHoldParams',
      result: 'GameAck',
    },
    [GameBridgeMethod.PacingRelease]: {
      sender: 'bellis',
      params: 'GamePacingReleaseParams',
      result: 'GameAck',
    },
    [GameBridgeMethod.SituationObserved]: {
      sender: 'runtime',
      params: 'GameSituationObserved',
      result: null,
    },
    [GameBridgeMethod.DecisionPointOpened]: {
      sender: 'runtime',
      params: 'GameDecisionPointOpened',
      result: null,
    },
    [GameBridgeMethod.ActionCommitted]: {
      sender: 'runtime',
      params: 'GameActionCommitted',
      result: null,
    },
    [GameBridgeMethod.HealthReported]: {
      sender: 'runtime',
      params: 'GameMainHealth',
      result: null,
    },
  },
  [GameBridgeRole.Core]: {
    [GameBridgeMethod.Describe]: {
      sender: 'bellis',
      params: 'GameDescribeParams',
      result: 'GameCoreDescription',
    },
    [GameBridgeMethod.LeaseRenew]: {
      sender: 'bellis',
      params: 'GameLeaseRenewParams',
      result: 'GameAck',
    },
    [GameBridgeMethod.InputStop]: {
      sender: 'bellis',
      params: 'GameInputStopParams',
      result: 'GameAck',
    },
    [GameBridgeMethod.InputReleased]: {
      sender: 'runtime',
      params: 'GameInputReleased',
      result: null,
    },
    [GameBridgeMethod.HealthReported]: {
      sender: 'runtime',
      params: 'GameCoreHealth',
      result: null,
    },
  },
} as const satisfies Record<GameBridgeRole, Readonly<Record<string, GameBridgeMethodSpec>>>;

export const gameBridgeV2Schemas = {
  GameDescribeVersion,
  GameDescribeParams,
  GameMainDescriptionV2,
  GameAck,
  GameGoalSubmitParamsV2,
  GameTaskOpenParams,
  GameTaskOpenResult,
  GameActionResolveOutcomeParams,
  GameActionResolveOutcomeResult,
  GameDecisionResolveParams,
  GamePacingHoldParams,
  GamePacingReleaseParams,
  GameSituationObserved,
  GameDecisionPointOpened,
  GameActionCommitted,
  GameMainHealthV2,
} as const;

/** 语义 v2 单独协商，实时核使用 v1 的控制契约。 */
export const GameBridgeV2Methods = {
  [GameBridgeRole.Main]: {
    ...GameBridgeMethods[GameBridgeRole.Main],
    [GameBridgeMethod.Describe]: {
      ...GameBridgeMethods[GameBridgeRole.Main][GameBridgeMethod.Describe],
      result: 'GameMainDescriptionV2',
    },
    [GameBridgeMethod.GoalSubmit]: {
      ...GameBridgeMethods[GameBridgeRole.Main][GameBridgeMethod.GoalSubmit],
      params: 'GameGoalSubmitParamsV2',
    },
    [GameBridgeMethod.HealthReported]: {
      ...GameBridgeMethods[GameBridgeRole.Main][GameBridgeMethod.HealthReported],
      params: 'GameMainHealthV2',
    },
    [GameBridgeMethod.TaskOpen]: {
      sender: 'bellis',
      params: 'GameTaskOpenParams',
      result: 'GameTaskOpenResult',
    },
    [GameBridgeMethod.ActionResolveOutcome]: {
      sender: 'bellis',
      params: 'GameActionResolveOutcomeParams',
      result: 'GameActionResolveOutcomeResult',
    },
  },
} as const satisfies Partial<
  Record<GameBridgeRole, Readonly<Record<string, GameBridgeMethodSpec>>>
>;
