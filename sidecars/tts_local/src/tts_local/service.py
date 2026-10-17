"""`tts.info`、`tts.synthesize` 与模型状态（见 `packages/protocol/src/tts.ts`）。

- 握手立即完成；模型在后台的守护线程里加载，状态变化时发 `tts.status` 通知。
  未就绪时 `tts.synthesize` 以 `TTS_NOT_READY` 拒绝。加载失败后状态不再变化，由操作员重启。
- 音频不走 JSON：每块 PCM 前加 4 字节大端流编号，经通道的二进制帧送回。
- 强制对齐：一句的音频送完后对整句做一次对齐，时间戳经 `tts.words` 通知送回；对齐出错只记日志，
  宿主保留插值（R-11）。
- `tts.synthesize` 在全部音频帧与时间戳之后才应答，应答即流结束。宿主发 `rpc.cancel` 时
  处理任务被取消，后端的生成器随之关闭、停止送出。本地模型一次只合成一句，请求按到达顺序排队。
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import struct

from pydantic import ValidationError

from bellis_sidecar.protocol import SidecarHealthResult
from bellis_sidecar.rpc import INVALID_PARAMS, Params, RpcError, RpcPeer
from bellis_sidecar.runtime import run_blocking

from .backend import Backend
from .protocol import (
    State,
    TtsInfoResult,
    TtsStatus,
    TtsSynthesizeParams,
    TtsSynthesizeResult,
    TtsWordsParams,
    Word,
)

TTS_INFO = 'tts.info'
TTS_SYNTHESIZE = 'tts.synthesize'
TTS_STATUS = 'tts.status'
TTS_WORDS = 'tts.words'
#: 与 `packages/protocol` 的 TTS_NOT_READY 一致。
TTS_NOT_READY = -32001
#: 音频帧帧首：流编号，4 字节大端。
STREAM_HEADER = struct.Struct('>I')
MAX_WORDS = 500
MAX_WORD_CHARS = 64

log = logging.getLogger('tts_local')


class TtsService:
    def __init__(self, peer: RpcPeer, backend: Backend) -> None:
        self._peer = peer
        self._backend = backend
        self._lock = asyncio.Lock()
        self.status = TtsStatus(state=State.loading, detail='模型加载中')
        self.loaded = asyncio.get_running_loop().create_task(self._load())
        peer.handle(TTS_INFO, self._info)
        peer.handle(TTS_SYNTHESIZE, self._synthesize)

    async def health(self) -> SidecarHealthResult:
        # 进程与连接正常即健康；模型是否就绪另由 tts.status 报告。
        return SidecarHealthResult(ok=True, detail=f'backend={self._backend.name}')

    def _set(self, status: TtsStatus) -> None:
        self.status = status
        if self._peer.connection.is_open:
            self._peer.notify(TTS_STATUS, status.model_dump(mode='json', exclude_none=True))

    async def _load(self) -> None:
        try:
            loaded = await run_blocking(self._backend.load)
        except Exception as error:
            log.exception('模型加载失败')
            detail = f'模型加载失败：{error}'[:200]
            self._set(TtsStatus(state=State.failed, detail=detail))
            return
        self._set(TtsStatus(state=State.ready, sampleRate=loaded.sample_rate, detail=loaded.detail))

    async def _info(self, _params: Params) -> object:
        return TtsInfoResult(
            backend=self._backend.name, processes=self._backend.processes(), status=self.status
        ).model_dump(mode='json', exclude_none=True)

    async def _synthesize(self, params: Params) -> object:
        try:
            request = TtsSynthesizeParams.model_validate(params, strict=True)
        except ValidationError as error:
            raise RpcError(INVALID_PARAMS, 'Invalid params') from error
        if self.status.state != State.ready:
            raise RpcError(TTS_NOT_READY, self.status.detail or '模型尚未就绪')
        header = STREAM_HEADER.pack(request.stream)
        samples = 0
        pcm = bytearray()
        async with self._lock:
            async with contextlib.aclosing(self._backend.synthesize(request.text)) as chunks:
                async for chunk in chunks:
                    await self._peer.send_binary(header + chunk)
                    samples += len(chunk) // 2
                    pcm += chunk
            await self._send_words(request.stream, request.text, bytes(pcm))
        return TtsSynthesizeResult(samples=samples).model_dump(mode='json')

    async def _send_words(self, stream: int, text: str, pcm: bytes) -> None:
        try:
            stamps = await self._backend.align(text, pcm)
        except Exception:
            log.exception('强制对齐失败，保留插值')
            return
        if not stamps:
            return
        words = [
            Word(text=s.text[:MAX_WORD_CHARS], startMs=max(0.0, s.start_ms), endMs=max(0.0, end))
            for s in stamps[:MAX_WORDS]
            if s.text
            for end in (max(s.start_ms, s.end_ms),)
        ]
        message = TtsWordsParams(stream=stream, words=words)
        self._peer.notify(TTS_WORDS, message.model_dump(mode='json'))
