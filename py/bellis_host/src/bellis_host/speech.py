"""Journaled, preemptible speech driven by the Stage playback cursor."""

import asyncio
import re
from bisect import bisect_left, bisect_right
from collections import deque
from collections.abc import AsyncGenerator, AsyncIterator, Callable, Sequence
from contextlib import suppress
from dataclasses import dataclass, field
from enum import IntEnum
from threading import get_ident
from typing import Literal, Protocol
from uuid import uuid4

from .safety import IntentRequest, Lease, LeaseUpdate, SafetyCore, SafetyError
from .stage import StageEvent, StageServer
from .store import HostStore, IntentSource, IntentState
from .tts import TtsChunk, WordStamp

type Status = Literal["completed", "interrupted", "denied", "failed"]


def speakable(subtitle: str) -> tuple[str, list[int]]:
    silent = "~～*#_`|<>[]{}()（）「」『』【】《》\"'“”‘’…—-"
    align = [i for i, c in enumerate(subtitle) if c not in silent]
    digits = str.maketrans("0123456789", "零一二三四五六七八九")
    return "".join(subtitle[i] for i in align).translate(digits), align


class Segmenter:
    def __init__(self) -> None:
        self.buffer = ""
        self.first = True

    def push(self, text: str) -> list[str]:
        self.buffer += text
        out: list[str] = []
        while self.buffer:
            window = self.buffer[:60]
            boundary = r"[。！？.!?；;\n]+”?"
            if self.first:
                boundary += r"|(?<=.{3})[，、,：:]"
            if match := re.search(boundary, window):
                cut = match.end()
            elif len(window) == 60:
                cut = max((m.end() for m in re.finditer(r"[，、,：:]", window)), default=60)
            else:
                break
            line, self.buffer = self.buffer[:cut].strip(), self.buffer[cut:]
            if speakable(line)[0].strip():
                out.append(line)
                self.first = False
        return out

    def flush(self) -> list[str]:
        return self.push("\n")


def subtitle_starts(
    spoken: str,
    align: Sequence[int],
    subtitle_len: int,
    sample_rate: int,
    words: Sequence[WordStamp],
    total_samples: int | None,
) -> list[int]:
    if not spoken:
        return []
    # Match vendor word text in order. Interpolate the gaps between known boundaries.
    n, pos = len(spoken), 0
    anchors = {0: 0}
    for word in words:
        at = spoken.find(word.text, pos)
        if at < 0 or not word.text:
            continue
        pos = at + len(word.text)
        for j in range(len(word.text) + 1):
            ms = word.start_ms + (word.end_ms - word.start_ms) * j / len(word.text)
            anchors[at + j] = round(ms * sample_rate / 1000)
    estimate = anchors[pos] + round((n - pos) * sample_rate * 0.15)
    anchors[n] = estimate if total_samples is None else total_samples
    starts: list[int] = []
    left = sample = 0
    for right, value in sorted(anchors.items()):
        value = max(sample, min(value, total_samples) if total_samples is not None else value)
        starts.extend(sample + (value - sample) * k // (right - left) for k in range(right - left))
        left, sample = right, value
    return [starts[min(n - 1, bisect_left(align, k))] for k in range(subtitle_len)]


def heard_prefix(
    subtitle: str, starts: Sequence[int], played: int, total_samples: int | None
) -> str:
    if total_samples and played >= total_samples:
        return subtitle
    _, align = speakable(subtitle)
    ends = [starts[k] for k in align[1:] if k < len(starts)]
    count = bisect_right(ends, played) if played > 0 else 0
    return subtitle[: align[count - 1] + 1] if count else ""


class SpeechPriority(IntEnum):
    AMBIENT = 0
    CHAT = 1
    OPERATOR = 2
    SYSTEM = 3


@dataclass(frozen=True)
class SpeechRequest:
    key: str
    text: str | AsyncIterator[str]
    priority: SpeechPriority = SpeechPriority.CHAT
    source: IntentSource = IntentSource.AGENT
    holder: str = "speech"
    reply_to: str | None = None


@dataclass(frozen=True)
class SpeechOutcome:
    key: str
    status: Status
    heard_text: str
    full_text: str
    reason: str = ""


class TtsSynthesizer(Protocol):
    @property
    def sample_rate(self) -> int: ...

    def synthesize(
        self, text: str, *, cancel: asyncio.Event | None = None
    ) -> AsyncIterator[TtsChunk]: ...


@dataclass
class _Utterance:
    request: SpeechRequest
    done: asyncio.Event = field(default_factory=asyncio.Event)
    cancel: asyncio.Event = field(default_factory=asyncio.Event)
    terminal: asyncio.Event = field(default_factory=asyncio.Event)
    worker: asyncio.Task[None] | None = None
    lease: Lease | None = None
    sid: str = ""
    subtitle: str = ""
    starts: list[int] = field(default_factory=list[int])
    played: int = 0
    total: int | None = None
    thread: int = field(default_factory=get_ident)
    heard: str = ""
    full: str = ""
    reason: str = ""
    truncate: asyncio.Task[None] | None = None


class SpeechArbiter:
    def __init__(
        self,
        safety: SafetyCore,
        store: HostStore,
        stage: StageServer,
        tts: TtsSynthesizer,
        *,
        max_history: int = 12,
    ):
        self.safety, self.store, self.stage, self.tts = safety, store, stage, tts
        self._history: deque[str] = deque(maxlen=max_history)
        self._active: _Utterance | None = None
        self._pending: set[asyncio.Event] = set()
        self._generation = 0
        self._closed = False
        self._off_stage: Callable[[], None] | None = stage.on_event(self._event)
        self._off_lease = safety.on_lease_update(self._lease_changed)
        self._off_stop = safety.on_emergency(lambda e: self.interrupt(e.reason))

    def interrupt(self, reason: str = "interrupted") -> None:
        self._generation += 1
        a = self._active
        if a and a.worker and not a.worker.done():
            if get_ident() == a.thread:
                self._stop(a, reason)
            else:
                a.worker.get_loop().call_soon_threadsafe(self._stop, a, reason)

    def _stop(self, a: _Utterance, reason: str) -> None:
        if a is not self._active or a.cancel.is_set():
            return
        a.reason = reason
        a.cancel.set()
        if a.sid:
            a.truncate = asyncio.create_task(self.stage.truncate_sentence(a.sid))
        if a.lease and self.safety.is_lease_valid("stage.audio", a.lease.token):
            self.safety.revoke_lease("stage.audio", reason)
        if a.worker:
            a.worker.cancel()

    def _event(self, event: StageEvent) -> None:
        a = self._active
        if a and event.kind == "muted":
            self._stop(a, event.reason or "muted")
        elif a and a.sid == event.sentence_id:
            a.played = max(a.played, event.played)
            if event.kind in {"ended", "truncated"}:
                a.terminal.set()
                if event.kind == "truncated":
                    self._stop(a, event.reason or "truncated")

    def _lease_changed(self, change: LeaseUpdate) -> None:
        a = self._active
        if not a or not a.lease or a.cancel.is_set() or change.resource != a.lease.resource:
            return
        if not change.lease or change.lease.token != a.lease.token:
            self.interrupt(change.reason)

    async def _sentence(self, a: _Utterance, subtitle: str, token: int) -> None:
        spoken, align = speakable(subtitle)
        sid, rate = uuid4().hex, self.tts.sample_rate
        a.sid, a.subtitle, a.played, a.total = sid, subtitle, 0, None
        a.terminal.clear()
        words: tuple[WordStamp, ...] = ()

        def timing(total: int | None) -> list[int]:
            return subtitle_starts(spoken, align, len(subtitle), rate, words, total)

        a.starts = timing(None)
        await self.stage.begin_sentence(sid, token, subtitle, rate)
        await self.stage.send_timing(sid, token, a.starts)
        samples = 0
        stream = self.tts.synthesize(spoken, cancel=a.cancel)
        try:
            async for chunk in stream:
                if a.cancel.is_set():
                    raise asyncio.CancelledError
                if chunk.sample_rate != rate or len(chunk.pcm) % 2:
                    raise ValueError("invalid TTS audio format")
                if chunk.words:
                    words = chunk.words
                    a.starts = timing(None)
                    await self.stage.send_timing(sid, token, a.starts)
                if chunk.pcm:
                    await self.stage.send_audio(sid, token, chunk.pcm)
                    samples += len(chunk.pcm) // 2
        finally:
            if isinstance(stream, AsyncGenerator):
                await stream.aclose()
        if not samples:
            raise ValueError("empty TTS audio")
        a.total, a.starts = samples, timing(samples)
        await self.stage.send_timing(sid, token, a.starts)
        await self.stage.end_sentence(sid, token)
        await asyncio.wait_for(a.terminal.wait(), samples / rate + 3)
        if a.played != samples:
            raise ValueError("incomplete Stage playback")
        a.heard, a.sid = a.heard + subtitle, ""

    async def _play(self, a: _Utterance, token: int) -> None:
        if not self.safety.is_lease_valid("stage.audio", token):
            raise SafetyError("lease_lost")
        seg, source = Segmenter(), a.request.text
        if not isinstance(source, str):
            async for part in source:
                a.full += part
                for line in seg.push(part):
                    await self._sentence(a, line, token)
        for line in seg.push(source if isinstance(source, str) else "") + seg.flush():
            await self._sentence(a, line, token)

    async def speak(self, request: SpeechRequest) -> SpeechOutcome:
        a = _Utterance(request, full=request.text if isinstance(request.text, str) else "")
        if self._closed:
            return SpeechOutcome(request.key, "denied", "", a.full, "closed")
        payload = {"reply_to": request.reply_to}
        caps = frozenset({"speech.output"})
        intent = IntentRequest(
            request.holder, request.key, "speech.say", "stage.audio", payload, request.source, caps
        )
        gate = self.safety.authorize_intent(intent)
        if not gate.allowed or not gate.intent or gate.duplicate:
            return SpeechOutcome(request.key, "denied", "", a.full, gate.reason)
        self._pending.add(a.done)
        generation = self._generation
        status: Status = "interrupted"
        try:
            while active := self._active:
                if request.priority > active.request.priority:
                    self._stop(active, "preempted")
                await active.done.wait()
            if self._closed or generation != self._generation:
                raise asyncio.CancelledError
            self._active = a
            self.store.mark_executing(gate.intent.id)
            a.lease = lease = self.safety.grant_lease("stage.audio", request.holder)
            a.worker = asyncio.create_task(self._play(a, lease.token))
            while not a.worker.done():
                await asyncio.wait([a.worker], timeout=lease.ttl_s / 3)
                if not a.worker.done() and not a.cancel.is_set():
                    self.safety.renew_lease(lease.resource, lease.holder, lease.token)
            await a.worker
            status = "interrupted" if a.cancel.is_set() else "completed"
        except (asyncio.CancelledError, SafetyError) as exc:
            self._stop(a, a.reason or str(exc) or "interrupted")
        except Exception as exc:
            status = "interrupted" if a.cancel.is_set() else "failed"
            self._stop(a, str(exc) or type(exc).__name__)
        finally:
            if a.worker and not a.worker.done():
                await asyncio.gather(a.worker, return_exceptions=True)
            if a.truncate:
                with suppress(Exception):
                    await asyncio.wait_for(asyncio.gather(a.truncate, a.terminal.wait()), 0.5)
            if a.sid:
                a.heard += heard_prefix(a.subtitle, a.starts, a.played, a.total)
            if a is self._active:
                self._active = None
            if a.lease and self.safety.is_lease_valid("stage.audio", a.lease.token):
                self.safety.revoke_lease("stage.audio", a.reason or status)
            self._pending.remove(a.done)
            a.done.set()
            state = IntentState.SUCCEEDED if status == "completed" else IntentState.FAILED
            result = {"status": status, "heard_text": a.heard}
            self.store.finish_intent(gate.intent.id, state, result=result, error=a.reason or None)
            if a.heard:
                self._history.append(a.heard)
        return SpeechOutcome(request.key, status, a.heard, a.full, a.reason)

    def recent_heard(self) -> tuple[str, ...]:
        return tuple(self._history)

    async def quiesce(self) -> None:
        self.interrupt("closed")
        self._closed = True
        await asyncio.gather(*(done.wait() for done in self._pending))
        if self._off_stage:
            self._off_stage()
            self._off_stop()
            self._off_lease()
            self._off_stage = None

    close = quiesce
