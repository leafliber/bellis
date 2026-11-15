# 由 packages/protocol 的 TypeBox 定义经 `pnpm run gen` 生成，勿手改（D-21）。

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictFloat, StrictInt, StrictStr


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


class GameCoreDescription(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    major: Annotated[StrictInt, Field(ge=1, le=65535)]
    runtimeId: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]
    nowMs: Annotated[StrictInt, Field(ge=0, le=18446744073709)]


class GameCoreHealth(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    atMs: Annotated[StrictInt, Field(ge=0, le=18446744073709)]
    leaseState: Literal['not_granted', 'valid', 'expired', 'revoked', 'source_lost']
    frameAgeMs: FrameAgeMs | None
    queueDepth: Annotated[StrictInt, Field(ge=0, le=4294967295)]


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


class GameGoalSubmitParams(BaseModel):
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


class GameInputReleased(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    token: Token | None
    atMs: Annotated[StrictInt, Field(ge=0, le=18446744073709)]
    reason: Literal[
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
    ]
    verification: Literal['verified', 'residual', 'unverified']


class GameInputStopParams(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    throughToken: Annotated[StrictInt, Field(ge=0, le=9007199254740991)]
    reason: Annotated[StrictStr, Field(max_length=200, min_length=1)]


class GameLeaseRenewParams(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    token: Annotated[StrictInt, Field(ge=1, le=9007199254740991)]
    expiresAtMs: Annotated[StrictInt, Field(ge=0, le=18446744073709)]


class GameMainDescription(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    major: Annotated[StrictInt, Field(ge=1, le=65535)]
    runtimeId: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')]
    nowMs: Annotated[StrictInt, Field(ge=0, le=18446744073709)]
    adapter: Adapter
    prerequisites: Annotated[list[Prerequisite], Field(max_length=64)]


class GameMainHealth(BaseModel):
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


type GoalId = DecisionPointId


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


class Prerequisite(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    id: Annotated[StrictStr, Field(pattern='^[a-z][a-z0-9-]{0,47}$')]
    text: Annotated[StrictStr, Field(max_length=240, min_length=1)]
    confirmed: StrictBool


class PreviousFailure(Failure):
    pass


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


type Token = Annotated[StrictInt, Field(ge=1, le=9007199254740991)]


type Traceparent = Annotated[StrictStr, Field(pattern='^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$')]
