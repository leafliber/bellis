# 由 packages/protocol 的 TypeBox 定义经 `pnpm run gen` 生成，勿手改（D-21）。

from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr

type Process = Annotated[StrictInt, Field(ge=1)]


class TtsInfoResult(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    sampleRate: Annotated[StrictInt, Field(ge=8000, le=48000)]
    backend: Annotated[StrictStr, Field(max_length=32, pattern='^[a-z][a-z0-9-]*$')]
    processes: Annotated[list[Process], Field(max_length=64)]


class TtsSynthesizeParams(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    stream: Annotated[StrictInt, Field(ge=1, le=4294967295)]
    text: Annotated[StrictStr, Field(max_length=500, min_length=1)]


class TtsSynthesizeResult(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    samples: Annotated[StrictInt, Field(ge=0)]
