# 由 packages/protocol 的 TypeBox 定义经 `pnpm run gen` 生成，勿手改（D-21）。

from __future__ import annotations

from enum import StrEnum
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr

type Process = Annotated[StrictInt, Field(ge=1)]


class State(StrEnum):
    loading = 'loading'
    ready = 'ready'
    failed = 'failed'


class Status(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    state: State
    detail: Annotated[StrictStr | None, Field(max_length=200)] = None
    sampleRate: Annotated[StrictInt | None, Field(ge=8000, le=48000)] = None


class TtsInfoResult(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    backend: Annotated[StrictStr, Field(max_length=32, pattern='^[a-z][a-z0-9-]*$')]
    processes: Annotated[list[Process], Field(max_length=64)]
    status: Status


class TtsStatus(Status):
    pass


class TtsSynthesizeParams(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    stream: Annotated[StrictInt, Field(ge=1, le=4294967295)]
    text: Annotated[StrictStr, Field(max_length=500, min_length=1)]
    traceparent: Annotated[
        StrictStr | None, Field(pattern='^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$')
    ] = None


class TtsSynthesizeResult(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    samples: Annotated[StrictInt, Field(ge=0)]


class TtsWordsParams(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    stream: Annotated[StrictInt, Field(ge=1, le=4294967295)]
    words: Annotated[list[Word], Field(max_length=500)]


class Word(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    text: Annotated[StrictStr, Field(max_length=64, min_length=1)]
    startMs: Annotated[float, Field(ge=0.0)]
    endMs: Annotated[float, Field(ge=0.0)]
