# 由 packages/protocol 的 TypeBox 定义经 `pnpm run gen` 生成，勿手改（D-21）。

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    StringConstraints,
)


class ChannelAccept(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    type: Literal['accept']


class ChannelChallenge(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    type: Literal['challenge']
    nonce: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9_-]{43}$')]
    proof: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9_-]{43}$')]


class ChannelHello(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    type: Literal['hello']
    role: Annotated[StrictStr, Field(pattern='^[a-z][a-z0-9_.:-]{0,63}$')]
    nonce: Annotated[StrictStr, Field(pattern='^[A-Za-z0-9_-]{43}$')]


class Error(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    code: StrictInt
    message: StrictStr
    data: Any | None = None


type Id = Annotated[StrictStr, Field(max_length=128, min_length=1)]


type Id1 = Annotated[StrictInt, Field(ge=-9007199254740991, le=9007199254740991)]


type Id2 = Id


type Id3 = Id1


type Id4 = Id


type Id5 = Id1


type Id6 = Id


type Id7 = Id1


type Permission = Annotated[
    StrictStr,
    Field(
        pattern='^(?:[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)*(:[A-Za-z0-9.-]+)?|net\\.egress:\\*\\.[A-Za-z0-9.-]+)$'
    ),
]


class ProcessShutdownParams(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    reason: Annotated[StrictStr | None, Field(max_length=200)] = None


class ProcessShutdownResult(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    accepted: StrictBool


type Provide = Annotated[StrictStr, Field(pattern='^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)*@[0-9]+$')]


class Qos(StrEnum):
    high = 'high'
    eco = 'eco'
    default = 'default'
    unknown = 'unknown'
    unsupported = 'unsupported'


class RpcCancelParams(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    id: Id6 | Id7


class RpcFailure(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    jsonrpc: Literal['2.0']
    id: Id4 | Id5 | None
    error: Error


class RpcNotification(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    jsonrpc: Literal['2.0']
    method: Annotated[StrictStr, Field(pattern='^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$')]
    params: dict[Annotated[str, StringConstraints(pattern=r'^.*$', strict=True)], Any] | None = None


class RpcRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    jsonrpc: Literal['2.0']
    id: Id | Id1
    method: Annotated[StrictStr, Field(pattern='^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$')]
    params: dict[Annotated[str, StringConstraints(pattern=r'^.*$', strict=True)], Any] | None = None


class RpcSuccess(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    jsonrpc: Literal['2.0']
    id: Id2 | Id3
    result: Any


class SidecarDescription(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    protocol: Literal[1]
    provides: list[Provide]
    permissions: list[Permission]


class SidecarHealthResult(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    ok: StrictBool
    detail: Annotated[StrictStr | None, Field(max_length=200)] = None
    qos: Qos | None = None


class SidecarTelemetry(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    dir: Annotated[StrictStr, Field(max_length=1024, min_length=1)]
    maxFileBytes: Annotated[StrictInt, Field(ge=65536)]
    maxFileAgeMs: Annotated[StrictInt, Field(ge=1000)]
    maxFiles: Annotated[StrictInt, Field(ge=1, le=1000)]
    maxQueue: Annotated[StrictInt, Field(ge=1)]
    flushIntervalMs: Annotated[StrictInt, Field(ge=1)]
