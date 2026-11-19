import type { TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import {
  GAME_BRIDGE_INTEGER_FIELDS,
  GAME_BRIDGE_MAJOR,
  GAME_BRIDGE_SEMANTIC_V2,
  GAME_BRIDGE_V1_INTEGER_FIELDS,
  type GameActionCommitted,
  type GameBridgeMajor,
  GameBridgeMethod,
  type GameBridgeMethodSpec,
  GameBridgeMethods,
  GameBridgeRole,
  type GameBridgeSchemaName,
  type GameBridgeSender,
  GameBridgeV2Methods,
  type GameDecisionPointOpened,
  type GameDecisionResolveParams,
  GameDescribeVersion,
  type GameGoalSubmitParams,
  type GameLeaseRenewParams,
  type GameMainDescription,
  type GameMainHealth,
  type GameMainHealthV2,
  GameScreenType,
  type GameSituationObserved,
  gameBridgeSchemas,
  gameBridgeV2Schemas,
} from './game-bridge.ts';
import { RpcFailure, RpcNotification, RpcRequest, RpcSuccess } from './jsonrpc.ts';

function compileSchemas(schemas: Record<string, TSchema>) {
  return new Map(Object.entries(schemas).map(([name, schema]) => [name, Compile(schema)]));
}

const validators = compileSchemas(gameBridgeSchemas);
const mainV2Validators = compileSchemas(gameBridgeV2Schemas);
const request = Compile(RpcRequest);
const notification = Compile(RpcNotification);
const success = Compile(RpcSuccess);
const failure = Compile(RpcFailure);
const descriptionVersion = Compile(GameDescribeVersion);
const genericScreenTypes = new Set<string>(GameScreenType.enum);

const integerFields = new Set<string>(GAME_BRIDGE_INTEGER_FIELDS);
const v1IntegerFields = new Set<string>(GAME_BRIDGE_V1_INTEGER_FIELDS);
const integerLiteral = /^(?:0|-?[1-9][0-9]*)$/;

/** 先读握手的公共主版本字段。只在收到所请求的 game.describe 应答时使用。 */
export function readGameBridgeMajor(description: unknown): number | undefined {
  return descriptionVersion.Check(description) ? description.major : undefined;
}

/** 认证后的游戏连接在这里解码原始 JSON，趁 JS 仍能读到数字的原始写法。 */
export function parseGameBridgeJson(
  raw: string,
  knownMajor: GameBridgeMajor = GAME_BRIDGE_MAJOR,
): unknown {
  const fields = knownMajor === GAME_BRIDGE_MAJOR ? v1IntegerFields : integerFields;
  const malformed: Array<{ holder: object; key: string }> = [];
  const message: unknown = JSON.parse(
    raw,
    function (this: object, key: string, value: unknown, context?: { source?: string }) {
      if (
        typeof value === 'number' &&
        fields.has(key) &&
        (!Number.isSafeInteger(value) || !integerLiteral.test(context?.source ?? ''))
      ) {
        malformed.push({ holder: this, key });
      }
      return value;
    },
  );
  if (malformed.length === 0) return message;
  const malformedAt = (record: unknown, field: string) =>
    malformed.some(({ holder, key }) => holder === record && key === field);
  if (!malformedAt(message, 'id')) {
    // 错误详情沿用 JSON-RPC 的任意 JSON 值。
    if (failure.Check(message) && !malformedAt(message.error, 'code')) return message;
    // 未知版本只解码公共的 major，正文留给上层报告版本不兼容。
    if (success.Check(message)) {
      const version = readGameBridgeMajor(message.result);
      if (
        version !== undefined &&
        version !== GAME_BRIDGE_MAJOR &&
        version !== knownMajor &&
        !malformedAt(message.result, 'major')
      ) {
        return message;
      }
    }
  }
  throw new SyntaxError('游戏桥整数字段须使用十进制 JSON 整数字面量');
}

const methods: Record<
  GameBridgeRole,
  Readonly<Record<string, GameBridgeMethodSpec>>
> = GameBridgeMethods;

const mainV2Methods: Readonly<Record<string, GameBridgeMethodSpec>> =
  GameBridgeV2Methods[GameBridgeRole.Main];

function methodSpec(
  role: GameBridgeRole,
  method: string,
  major: number,
): GameBridgeMethodSpec | undefined {
  const registered =
    major === GAME_BRIDGE_MAJOR
      ? methods[role]
      : major === GAME_BRIDGE_SEMANTIC_V2 && role === GameBridgeRole.Main
        ? mainV2Methods
        : undefined;
  return registered && Object.hasOwn(registered, method) ? registered[method] : undefined;
}

const unique = (ids: readonly string[]) => new Set(ids).size === ids.length;
const canExtend = (base: string) => base !== '卡住' && base !== '未知';

function checkDecision(point: GameDecisionPointOpened): boolean {
  const { options, candidates, timing, atMs } = point;
  const optionIds = new Set(options.map(({ id }) => id));
  if (
    optionIds.size !== options.length ||
    !unique(candidates.map(({ optionId }) => optionId)) ||
    !candidates.every(({ optionId, rank }, index) => optionIds.has(optionId) && rank === index + 1)
  ) {
    return false;
  }
  return (
    timing === null ||
    (candidates.length > 0 && atMs < timing.resolveByMs && timing.resolveByMs < timing.deadlineMs)
  );
}

/** 只校验单条消息内的关系；连接和当前游戏状态由两端处理。 */
function checkPayload(name: GameBridgeSchemaName, value: unknown, major: number): boolean {
  const schemas = major === GAME_BRIDGE_SEMANTIC_V2 ? mainV2Validators : validators;
  if (!schemas.get(name)?.Check(value)) return false;
  switch (name) {
    case 'GameDecisionPointOpened':
      return checkDecision(value as GameDecisionPointOpened);
    case 'GameGoalSubmitParams':
    case 'GameGoalSubmitParamsV2': {
      const goal = value as GameGoalSubmitParams;
      if (
        goal.localRecovery &&
        (goal.localDialogue ||
          (goal.localRecovery.kind !== 'recover' && goal.localRecovery.kind !== 'load') ||
          (goal.localRecovery.kind === 'load' &&
            goal.localRecovery.authorizationId === goal.localRecovery.openAuthorizationId))
      )
        return false;
      const scope = goal.localRecovery ?? goal.localDialogue;
      return (
        (goal.mode === 'waiting_vote') === (goal.decisionPointId !== null) &&
        (scope === undefined ||
          (goal.mode === 'autonomous' &&
            goal.goalId === scope.authorizationId &&
            goal.expiresAtMs === scope.expiresAtMs))
      );
    }
    case 'GameDecisionResolveParams': {
      const decision = value as GameDecisionResolveParams;
      const scope = decision.localRecovery;
      if (!scope) return decision.source !== 'operator';
      return (
        (scope.kind === 'prefix' || scope.kind === 'untried' || scope.kind === 'named') &&
        decision.source === 'operator' &&
        decision.decisionPointId === scope.decisionPointId &&
        decision.optionId === scope.optionId
      );
    }
    case 'GameLeaseRenewParams': {
      const lease = value as GameLeaseRenewParams;
      if (lease.localDialogue && lease.localRecovery) return false;
      if (
        lease.localRecovery?.kind === 'load' &&
        lease.localRecovery.authorizationId === lease.localRecovery.openAuthorizationId
      )
        return false;
      const scope = lease.localRecovery ?? lease.localDialogue;
      return scope === undefined || lease.expiresAtMs <= scope.expiresAtMs;
    }
    case 'GameActionCommitted': {
      const action = value as GameActionCommitted;
      return (action.category === 'select') === (action.selection !== null);
    }
    case 'GameMainDescription':
    case 'GameMainDescriptionV2': {
      const { adapter, prerequisites } = value as GameMainDescription;
      return (
        unique(prerequisites.map(({ id }) => id)) &&
        unique(adapter.screenTypes.map(({ name }) => name)) &&
        adapter.screenTypes.every(
          ({ name, base }) => !genericScreenTypes.has(name) && canExtend(base),
        )
      );
    }
    case 'GameSituationObserved': {
      const { screenType, screenTypeExtension, lookpoints, atMs } = value as GameSituationObserved;
      return (
        (screenTypeExtension === null ||
          (!genericScreenTypes.has(screenTypeExtension) && canExtend(screenType))) &&
        unique(lookpoints.map(({ id }) => id)) &&
        lookpoints.every((item) => item.atMs <= atMs)
      );
    }
    case 'GameMainHealth': {
      const health = value as GameMainHealth;
      const proof = health.localRecovery;
      return (
        unique(health.prerequisites.map(({ id }) => id)) &&
        (!proof ||
          (health.ready &&
            !health.riskLimitExceeded &&
            health.frameAgeMs !== null &&
            health.decisionPointId === ('decisionPointId' in proof ? proof.decisionPointId : null)))
      );
    }
    case 'GameMainHealthV2': {
      const health = value as GameMainHealthV2;
      return (
        (!health.ready || health.pendingActionOutcome === null) &&
        unique(health.prerequisites.map(({ id }) => id))
      );
    }
    default:
      return true;
  }
}

/** RpcPeer 已核对信封时，只校验角色、发送方与参数。 */
export function checkGameBridgeParams(
  role: GameBridgeRole,
  sender: GameBridgeSender,
  method: string,
  params: unknown,
  major: number = GAME_BRIDGE_MAJOR,
): boolean {
  const spec = methodSpec(role, method, major);
  return spec?.sender === sender && checkPayload(spec.params, params, major);
}

/** 校验一条应用请求或通知。JSON-RPC 的请求相关与 rpc.cancel 仍由通道处理。 */
export function checkGameBridgeMessage(
  role: GameBridgeRole,
  sender: GameBridgeSender,
  message: unknown,
  major: number = GAME_BRIDGE_MAJOR,
): boolean {
  if (request.Check(message)) {
    const spec = methodSpec(role, message.method, major);
    return (
      spec?.sender === sender &&
      spec.result !== null &&
      checkPayload(spec.params, message.params, major)
    );
  }
  if (notification.Check(message)) {
    const spec = methodSpec(role, message.method, major);
    return (
      spec?.sender === sender &&
      spec.result === null &&
      checkPayload(spec.params, message.params, major)
    );
  }
  return false;
}

/** 关联请求的 id 由 RpcPeer 核对，成功应答的载荷再按角色与请求方法核对。 */
export function checkGameBridgeResult(
  role: GameBridgeRole,
  method: string,
  result: unknown,
  major: number = GAME_BRIDGE_MAJOR,
): boolean {
  const spec = methodSpec(role, method, major);
  if (method === GameBridgeMethod.Describe && readGameBridgeMajor(result) !== major) {
    return false;
  }
  return spec !== undefined && spec.result !== null && checkPayload(spec.result, result, major);
}

export function checkGameBridgeSuccess(
  role: GameBridgeRole,
  method: string,
  response: unknown,
  major: number = GAME_BRIDGE_MAJOR,
): boolean {
  return success.Check(response) && checkGameBridgeResult(role, method, response.result, major);
}
