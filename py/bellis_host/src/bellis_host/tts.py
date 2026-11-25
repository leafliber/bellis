"""Serialized MiniMax bidirectional PCM synthesis."""

import asyncio
import json
import logging
import math
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Self, cast

from bellis_common.cred import CredError, read_secret_text
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import WebSocketException
from websockets.protocol import State


@dataclass(frozen=True)
class WordStamp:
    text: str
    start_ms: float
    end_ms: float


@dataclass(frozen=True)
class TtsChunk:
    pcm: bytes
    sample_rate: int
    # Latest full timing map, including revisions from word_streaming.
    words: tuple[WordStamp, ...] = ()


class TtsError(RuntimeError):
    def __init__(self, message: str, *, auth: bool = False, rate_limited: bool = False):
        super().__init__(message)
        self.auth, self.rate_limited = auth, rate_limited


@dataclass(frozen=True)
class MinimaxConfig:
    endpoint: str = "wss://api.minimax.cn/ws/v1/t2a_v2_bidi"
    model: str = "speech-2.8-turbo"
    voice_id: str = "female-tianmei"
    sample_rate: int = 24000
    speed: float = 1.0
    vol: float = 1.0
    pitch: int = 0
    emotion: str = ""
    language_boost: str = "Chinese"
    subtitle_type: str = "word_streaming"
    api_key_env: str = "BELLIS_MINIMAX_API_KEY"
    cred_targets: tuple[str, ...] = ("minimax.bellis",)
    connect_timeout_s: float = 10.0
    first_audio_timeout_s: float = 8.0
    stall_timeout_s: float = 8.0
    cancel_timeout_s: float = 2.0


def resolve_minimax_api_key(config: MinimaxConfig, explicit: str | None = None) -> str:
    if explicit is not None:
        return explicit
    if (value := os.getenv(config.api_key_env)) is not None:
        return value
    for target in config.cred_targets:
        if value := read_secret_text(target):
            return value
    return ""


def _dict(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TtsError("invalid MiniMax packet")
    return cast(dict[str, Any], value)


async def _recv(ws: ClientConnection) -> dict[str, Any]:
    packet = _dict(json.loads(await ws.recv()))
    code = _dict(packet.get("base_resp", {})).get("status_code", 0)
    if code or packet.get("event") == "task_failed":
        # Provider-supplied strings can echo the entire request, including credentials.
        raise TtsError("MiniMax rejected request", auth=code == 1004, rate_limited=code == 1002)
    return packet


def _words(sub: dict[str, Any], base_ms: float) -> tuple[WordStamp, ...]:
    rows = sub.get("timestamped_words") or [sub]
    result: list[WordStamp] = []
    for item in cast(list[object], rows):
        row = _dict(item)
        text = row.get("word", row.get("text"))
        if not isinstance(text, str) or not text:
            continue
        start = float(row.get("time_begin", 0))
        end = float(row.get("time_end", start))
        if not 0 <= start <= end < math.inf:
            raise TtsError("invalid MiniMax word timing")
        result.append(WordStamp(text, base_ms + start, base_ms + end))
    return tuple(result)


class MiniMaxTtsClient:
    def __init__(self, config: MinimaxConfig = MinimaxConfig(), *, api_key: str | None = None):
        self.config, self.sample_rate = config, config.sample_rate
        self._key = api_key
        self._lock = asyncio.Lock()
        self._ws: ClientConnection | None = None
        self._closed = False

    async def _session(self) -> ClientConnection:
        if self._closed:
            raise TtsError("MiniMax client closed")
        if self._ws and self._ws.state is State.OPEN:
            return self._ws
        c = self.config
        try:
            key = resolve_minimax_api_key(c, self._key)
        except CredError:
            raise TtsError("MiniMax credentials unavailable", auth=True) from None
        if not key:
            raise TtsError("missing MiniMax credentials", auth=True)
        # The transport's DEBUG handshake dump includes Authorization verbatim.
        logger = logging.Logger("bellis.minimax.transport")
        logger.disabled = True
        async with asyncio.timeout(c.connect_timeout_s):
            ws = await connect(
                c.endpoint,
                additional_headers={"Authorization": f"Bearer {key}"},
                logger=logger,
                proxy=None,
                close_timeout=c.cancel_timeout_s,
            )
            self._ws = ws
            if self._closed or (await _recv(ws)).get("event") != "connected_success":
                raise TtsError("MiniMax handshake failed")
            voice = {
                "voice_id": c.voice_id,
                "speed": c.speed,
                "vol": c.vol,
                "pitch": c.pitch,
                **({"emotion": c.emotion} if c.emotion else {}),
            }
            await ws.send(
                json.dumps(
                    {
                        "event": "task_start",
                        "model": c.model,
                        "voice_setting": voice,
                        "audio_setting": {
                            "sample_rate": c.sample_rate,
                            "format": "pcm",
                            "channel": 1,
                        },
                        "subtitle_enable": True,
                        "subtitle_type": c.subtitle_type,
                        **({"language_boost": c.language_boost} if c.language_boost else {}),
                    }
                )
            )
            if (await _recv(ws)).get("event") != "task_started":
                raise TtsError("MiniMax session refused")
            return ws

    async def _discard(self) -> None:
        ws, self._ws = self._ws, None
        if ws:
            await ws.close()

    async def _cancel(self, ws: ClientConnection) -> None:
        try:
            async with asyncio.timeout(self.config.cancel_timeout_s):
                await ws.send('{"event":"task_cancel"}')
                pending = {"task_canceled", "task_flushed"}
                while pending:
                    pending.discard((await _recv(ws)).get("event"))
        except asyncio.CancelledError:
            await self._discard()
            raise
        except (TimeoutError, WebSocketException, OSError, TtsError, ValueError, TypeError):
            await self._discard()

    async def synthesize(
        self, text: str, *, cancel: asyncio.Event | None = None
    ) -> AsyncIterator[TtsChunk]:
        async with self._lock:
            if cancel and cancel.is_set():
                return
            stop = asyncio.create_task(cancel.wait()) if cancel else None
            ws = None
            flushed = False
            try:
                ws = await self._session()
                if cancel and cancel.is_set():
                    return
                await ws.send(json.dumps({"event": "task_continue", "text": text}))
                await ws.send('{"event":"task_flush"}')
                flushed = True
                loop = asyncio.get_running_loop()
                deadline = loop.time() + self.config.first_audio_timeout_s
                samples = base = section = 0
                tail = b""
                segments: dict[tuple[int, int], tuple[WordStamp, ...]] = {}
                while not (cancel and cancel.is_set()):
                    read = asyncio.create_task(_recv(ws))
                    try:
                        async with asyncio.timeout_at(deadline):
                            if stop:
                                await asyncio.wait(
                                    (read, stop), return_when=asyncio.FIRST_COMPLETED
                                )
                                if not read.done():
                                    break
                            packet = await read
                    finally:
                        read.cancel()
                        await asyncio.gather(read, return_exceptions=True)
                    event = packet.get("event")
                    if event == "task_flushed":
                        if tail:
                            raise TtsError("incomplete MiniMax PCM sample")
                        flushed = False
                        return
                    if event == "sentence_start":
                        base = samples
                        section += 1
                    if event != "task_continued":
                        continue
                    data = _dict(packet.get("data") or {})
                    audio = tail + bytes.fromhex(data.get("audio") or "")
                    size = len(audio) & ~1
                    pcm, tail = audio[:size], audio[size:]
                    samples += size // 2
                    words: tuple[WordStamp, ...] = ()
                    if sub := data.get("subtitle"):
                        sub = _dict(sub)
                        segments[section, int(sub.get("text_begin", 0))] = _words(
                            sub, base * 1000 / self.sample_rate
                        )
                        words = tuple(w for segment in segments.values() for w in segment)
                    if pcm or words:
                        if not (cancel and cancel.is_set()):
                            yield TtsChunk(pcm, self.sample_rate, words)
                        if pcm:
                            deadline = loop.time() + self.config.stall_timeout_s
            except (asyncio.CancelledError, GeneratorExit):
                if not flushed:
                    await self._discard()
                raise
            except TtsError:
                flushed = False
                await self._discard()
                raise
            except (
                WebSocketException,
                OSError,
                ValueError,
                TypeError,
                OverflowError,
                RecursionError,
            ):
                flushed = False
                await self._discard()
                raise TtsError("MiniMax transport or response failed") from None
            finally:
                if stop:
                    stop.cancel()
                    await asyncio.gather(stop, return_exceptions=True)
                if flushed and ws:
                    await self._cancel(ws)

    async def close(self) -> None:
        self._closed = True
        await self._discard()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()
