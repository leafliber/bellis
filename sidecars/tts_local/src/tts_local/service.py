"""`tts.info` 与 `tts.synthesize`（见 `packages/protocol/src/tts.ts`）。

音频不走 JSON：每块 PCM 前加 4 字节大端流编号，经通道的二进制帧送回；
`tts.synthesize` 在全部音频帧之后才应答，应答即流结束。宿主发 `rpc.cancel` 时处理任务被取消，
后端的生成器随之关闭、停止生成。本地模型一次只合成一句，请求按到达顺序排队。
"""

from __future__ import annotations

import asyncio
import contextlib
import struct

from pydantic import ValidationError

from bellis_sidecar.rpc import INVALID_PARAMS, Params, RpcError, RpcPeer

from .backend import Backend
from .protocol import TtsInfoResult, TtsSynthesizeParams, TtsSynthesizeResult

TTS_INFO = 'tts.info'
TTS_SYNTHESIZE = 'tts.synthesize'
#: 音频帧帧首：流编号，4 字节大端。
STREAM_HEADER = struct.Struct('>I')


def register(peer: RpcPeer, backend: Backend) -> None:
    lock = asyncio.Lock()

    async def info(_params: Params) -> object:
        return TtsInfoResult(
            sampleRate=backend.sample_rate, backend=backend.name, processes=backend.processes()
        ).model_dump(mode='json')

    async def synthesize(params: Params) -> object:
        try:
            request = TtsSynthesizeParams.model_validate(params, strict=True)
        except ValidationError as error:
            raise RpcError(INVALID_PARAMS, 'Invalid params') from error
        header = STREAM_HEADER.pack(request.stream)
        samples = 0
        async with lock, contextlib.aclosing(backend.synthesize(request.text)) as chunks:
            async for chunk in chunks:
                await peer.send_binary(header + chunk)
                samples += len(chunk) // 2
        return TtsSynthesizeResult(samples=samples).model_dump(mode='json')

    peer.handle(TTS_INFO, info)
    peer.handle(TTS_SYNTHESIZE, synthesize)
