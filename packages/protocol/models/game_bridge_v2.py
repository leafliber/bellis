# 由 packages/protocol 的 TypeBox 定义经 `pnpm run gen` 生成，勿手改（D-21）。

from __future__ import annotations

import json
from typing import Annotated, Any, Literal, cast

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictFloat,
    StrictInt,
    StrictStr,
    ValidationError,
    model_validator,
)


class Adapter(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    id: Annotated[StrictStr, Field(pattern='^[a-z][a-z0-9-]{0,47}$')]
    version: Annotated[StrictStr, Field(max_length=32, min_length=1)]
    screenTypes: Annotated[list[ScreenType], Field(max_length=64)]


class Candidate(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    optionId: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]
    rank: Annotated[StrictInt, Field(ge=1, le=64)]
    reason: Annotated[StrictStr, Field(max_length=240, min_length=1)]
    citation: Citation | None
    previousFailure: PreviousFailure | None


type Citation = Annotated[StrictStr, Field(max_length=120, min_length=1)]


type Constraint = Annotated[StrictStr, Field(max_length=160, min_length=1)]


type CurrentLine = Annotated[StrictStr, Field(max_length=240, min_length=1)]


type DecisionPointId = Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]


type ActiveTaskId = DecisionPointId


class Error(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    code: StrictInt
    message: StrictStr
    data: Any | None = None


class Failure(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    source: Literal['director', 'vote', 'default'] | None
    summary: Annotated[StrictStr, Field(max_length=240, min_length=1)]


type FirstActionMs = Annotated[StrictInt, Field(ge=0, le=4294967295)]


type FrameAgeMs = FirstActionMs


class GameAck(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )


class GameActionCommitted(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    actionId: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]
    atMs: Annotated[StrictInt, Field(ge=0, le=18446744073709)]
    goalId: GoalId | None
    category: Literal['advance', 'navigate', 'select']
    summary: Annotated[StrictStr, Field(max_length=240, min_length=1)]
    selection: Selection | None
    traceparent: Traceparent | None


class GameActionResolveOutcomeParams(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    sessionId: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]
    attemptId: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]
    resolution: Literal['confirmed_executed', 'confirmed_not_executed', 'reconciled_unknown']


class GameActionResolveOutcomeResult(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    attemptId: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]
    resolution: Literal['confirmed_executed', 'confirmed_not_executed', 'reconciled_unknown']


class GameDecisionPointOpened(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    decisionPointId: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]
    atMs: Annotated[StrictInt, Field(ge=0, le=18446744073709)]
    prompt: Annotated[StrictStr, Field(max_length=360, min_length=1)]
    options: Annotated[list[Option], Field(max_length=64, min_length=1)]
    candidates: Annotated[list[Candidate], Field(max_length=64)]
    timing: Timing | None
    traceparent: Traceparent | None


class GameDecisionResolveParams(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    decisionPointId: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]
    optionId: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]
    source: Literal['director', 'vote']
    traceparent: Traceparent | None


class GameDescribeParams(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    major: Annotated[StrictInt, Field(ge=1, le=65535)]


class GameDescribeVersion(BaseModel):
    major: Annotated[StrictInt, Field(ge=1, le=65535)]


class GameGoalSubmitParamsV2(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    goalId: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]
    objective: Annotated[StrictStr, Field(max_length=600, min_length=1)]
    constraints: Annotated[list[Constraint], Field(max_length=16)]
    mode: Literal['autonomous', 'waiting_vote', 'paused', 'manual']
    decisionPointId: DecisionPointId | None
    expiresAtMs: Annotated[StrictInt, Field(ge=0, le=18446744073709)]
    traceparent: Traceparent | None
    taskId: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]


class GameMainDescriptionV2(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    major: Annotated[StrictInt, Field(ge=2, le=2)]
    runtimeId: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]
    nowMs: Annotated[StrictInt, Field(ge=0, le=18446744073709)]
    adapter: Adapter
    prerequisites: Annotated[list[Prerequisite], Field(max_length=64)]
    controlTargetId: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]


class GameMainHealthV2(BaseModel):
    @model_validator(mode='after')
    def _pending_requires_not_ready(self) -> GameMainHealthV2:
        if self.pendingActionOutcome is not None and self.ready:
            raise ValueError('有未决动作时不能报告就绪')
        return self

    model_config = ConfigDict(
        extra='forbid',
    )
    atMs: Annotated[StrictInt, Field(ge=0, le=18446744073709)]
    ready: StrictBool
    mode: Literal['autonomous', 'waiting_vote', 'paused', 'manual']
    goalId: GoalId | None
    decisionPointId: DecisionPointId | None
    prerequisites: Annotated[list[Prerequisite], Field(max_length=64)]
    firstActionMs: FirstActionMs | None
    frameAgeMs: FrameAgeMs | None
    queueDepth: Annotated[StrictInt, Field(ge=0, le=4294967295)]
    riskScore: Annotated[StrictFloat, Field(ge=0.0, le=1.0)]
    riskLimitExceeded: StrictBool
    lastRejection: LastRejection | None
    pendingActionOutcome: PendingActionOutcome | None
    activeTaskId: ActiveTaskId | None


class GamePacingHoldParams(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    holdId: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]
    reason: Annotated[StrictStr, Field(max_length=200, min_length=1)]
    expiresAtMs: Annotated[StrictInt, Field(ge=0, le=18446744073709)]
    traceparent: Traceparent | None


class GamePacingReleaseParams(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    holdId: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]
    traceparent: Traceparent | None


class GameSituationObserved(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    atMs: Annotated[StrictInt, Field(ge=0, le=18446744073709)]
    screenType: Literal[
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
    ]
    screenTypeExtension: ScreenTypeExtension | None
    summary: Annotated[StrictStr, Field(max_length=600, min_length=1)]
    currentLine: CurrentLine | None
    interactables: Annotated[list[Interactable], Field(max_length=32)]
    lookpoints: Annotated[list[Lookpoint], Field(max_length=16)]
    voiceActivity: Literal['busy', 'idle', 'unknown']
    rereading: StrictBool
    failure: Failure | None
    traceparent: Traceparent | None


class GameTaskOpenParams(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    taskId: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]
    objective: Annotated[StrictStr, Field(max_length=600, min_length=1)]
    expiresAtMs: Annotated[StrictInt, Field(ge=0, le=18446744073709)]
    overallCompletion: OverallCompletion | OverallCompletion1 | OverallCompletion2 | None


class GameTaskOpenResult(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    taskId: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]


type GoalId = DecisionPointId


type Id = Annotated[StrictStr, Field(max_length=128, min_length=1)]


type Id1 = Annotated[StrictInt, Field(ge=-9007199254740991, le=9007199254740991)]


type Id2 = Id


type Id3 = Id1


type Interactable = Constraint


class LastRejection(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    atMs: Annotated[StrictInt, Field(ge=0, le=18446744073709)]
    code: Annotated[StrictStr, Field(pattern='^[a-z][a-z0-9-]{0,47}$')]
    summary: Annotated[StrictStr, Field(max_length=200, min_length=1)]


class Lookpoint(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    id: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]
    kind: Annotated[StrictStr, Field(pattern='^[a-z][a-z0-9-]{0,47}$')]
    summary: Annotated[StrictStr, Field(max_length=240, min_length=1)]
    importance: Literal['medium', 'high']
    atMs: Annotated[StrictInt, Field(ge=0, le=18446744073709)]


class Option(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    id: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]
    label: Annotated[StrictStr, Field(max_length=240, min_length=1)]


class OverallCompletion(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    kind: Literal['signature']
    signature: Annotated[StrictStr, Field(max_length=120, min_length=1)]


class OverallCompletion1(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    kind: Literal['screen']
    screenType: Literal[
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
    ]


class OverallCompletion2(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    kind: Literal['text-appeared', 'text-disappeared']
    text: Annotated[StrictStr, Field(max_length=240, min_length=1)]
    roi: Annotated[StrictStr, Field(max_length=80, min_length=1)]


class PendingActionOutcome(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    attemptId: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]
    runtimeId: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]
    sessionId: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]
    goalId: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]
    actionId: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]
    decisionPointId: DecisionPointId | None
    reason: Annotated[StrictStr, Field(max_length=200, min_length=1)]


class Prerequisite(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    id: Annotated[StrictStr, Field(pattern='^[a-z][a-z0-9-]{0,47}$')]
    text: Annotated[StrictStr, Field(max_length=240, min_length=1)]
    confirmed: StrictBool


class PreviousFailure(Failure):
    pass


class RpcFailure(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    jsonrpc: Literal['2.0']
    id: Id | Id1 | None
    error: Error


class RpcSuccess(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    jsonrpc: Literal['2.0']
    id: Id2 | Id3
    result: Any


class ScreenType(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    name: Annotated[StrictStr, Field(max_length=80, min_length=1)]
    base: Literal[
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
    ]


type ScreenTypeExtension = Annotated[StrictStr, Field(max_length=80, min_length=1)]


class Selection(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    decisionPointId: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]
    optionId: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]
    source: Literal['director', 'vote', 'default']


class Timing(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    resolveByMs: Annotated[StrictInt, Field(ge=0, le=18446744073709)]
    deadlineMs: Annotated[StrictInt, Field(ge=0, le=18446744073709)]


type Traceparent = Annotated[StrictStr, Field(pattern='^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$')]

GAME_BRIDGE_MAJOR = 2
_MAX_SAFE_INTEGER = 9007199254740991
_INTEGER_FIELDS = frozenset(
    [
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
    ]
)


def read_game_bridge_major(description: object) -> int | None:
    """从已关联的 game.describe 应答正文读取公共主版本。"""
    try:
        return GameDescribeVersion.model_validate(description).major
    except ValidationError:
        return None


def parse_game_bridge_json(raw: str | bytes) -> object:
    """解码认证游戏连接的原始 JSON。信封和载荷的类型仍由相应模型校验。"""
    message: object = json.loads(
        raw.decode('utf-8') if isinstance(raw, bytes) else raw,
        parse_int=_parse_integer,
        parse_constant=_reject_json_constant,
    )
    if _has_version_independent_body(message):
        return message

    pending: list[object] = [message]
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            for name, item in cast('dict[str, object]', value).items():
                if name in _INTEGER_FIELDS:
                    _require_integer_literal(item)
                pending.append(item)
        elif isinstance(value, list):
            pending.extend(cast('list[object]', value))
    return message


def _parse_integer(raw: str) -> int | float:
    # 默认的浮点解析保留带小数点或指数的写法。把有符号零也保留为浮点。
    return -0.0 if raw == '-0' else int(raw)


def _reject_json_constant(_: str) -> None:
    raise ValueError('游戏桥 JSON 不允许 NaN 或 Infinity 字面量')


def _require_integer_literal(value: object) -> None:
    if isinstance(value, float) or (type(value) is int and abs(value) > _MAX_SAFE_INTEGER):
        raise ValueError('游戏桥整数字段须使用安全范围内的十进制 JSON 整数字面量')


def _has_version_independent_body(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    message = cast('dict[str, object]', value)
    if 'error' in message:
        try:
            failure = RpcFailure.model_validate(message)
        except ValidationError:
            return False
        # 错误详情是任意 JSON。信封模型已核对 id 的类型和安全整数范围。
        _require_integer_literal(failure.error.code)
        return True

    if 'result' not in message:
        return False
    major = read_game_bridge_major(message['result'])
    if major is None or major == GAME_BRIDGE_MAJOR:
        return False
    try:
        RpcSuccess.model_validate(message)
    except ValidationError:
        return False
    # 未知版本只检查共同的信封和主版本。正文留给握手报告版本不兼容。
    return True
