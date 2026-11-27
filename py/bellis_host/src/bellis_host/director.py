"""Event-driven host director. Only the speech arbiter can admit audio to Stage."""

import asyncio
import json
import time
from collections import deque
from collections.abc import AsyncGenerator, AsyncIterator
from dataclasses import dataclass
from threading import Lock, get_ident
from typing import Literal, cast
from uuid import uuid4

from bellis_common.agent_events import (
    CommandAck,
    ControlReleased,
    DecisionNeeded,
    FastEvent,
    GameVoiceChanged,
    SceneObserved,
    StepProgress,
)
from bellis_common.channel import ChannelError, RpcError
from bellis_common.wire_codec import ProtocolError

from .audience import AudienceHub, VoteSnapshot
from .director_llm import (
    DEFAULT_PERSONA as DEFAULT_PERSONA,
)
from .director_llm import (
    DirectorConfig as DirectorConfig,
)
from .director_llm import (
    IntentScanner as IntentScanner,
)
from .director_llm import (
    LlmStreamer as LlmStreamer,
)
from .director_llm import (
    OpenAiLlmClient as OpenAiLlmClient,
)
from .director_llm import (
    build_messages as build_messages,
)
from .director_llm import (
    resolve_llm_api_key as resolve_llm_api_key,
)
from .game_control import GameController, parse_game_directive
from .safety import HostMode, SafetyCore, SafetyError
from .speech import SpeechArbiter, SpeechRequest
from .store import IntentSource


@dataclass(frozen=True)
class DirectorResult:
    action: Literal["speak", "vote", "silence", "skipped", "interrupted", "error"]
    text: str = ""
    reply_to: str | None = None
    reason: str = ""
    game_ack: CommandAck | None = None


_DEFAULT_CONFIG = DirectorConfig()


class SlowDirector:
    def __init__(
        self, safety: SafetyCore, audience: AudienceHub, speech: SpeechArbiter,
        llm: LlmStreamer, *, config: DirectorConfig = _DEFAULT_CONFIG,
        game: GameController | None = None,
    ):  # fmt: skip
        self.safety, self.audience, self.speech = safety, audience, speech
        self.llm, self.config = llm, config
        self.game = game
        self._game_events: deque[FastEvent] = deque(maxlen=8)
        self._events_lock = Lock()
        self._vote_ended = False
        self._objective_resumed = False
        self._turn: asyncio.Task[DirectorResult] | None = None
        self._timer: asyncio.Task[None] | None = None
        self._votes: set[asyncio.Task[None]] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread = get_ident()
        self._cancel = asyncio.Event()
        self._closed = False
        self._off = safety.on_emergency(lambda _: self.interrupt("emergency"))

    async def start(self) -> None:
        self._loop, self._thread = asyncio.get_running_loop(), get_ident()

    def submit_danmaku(self, viewer_id: str, viewer_name: str, text: str) -> bool:
        if self._closed or not self.audience.ingest(viewer_id, viewer_name, text):
            return False
        self._wake_if_live()
        return True

    def submit_game_event(self, event: FastEvent) -> bool:
        if self._closed:
            return False
        if self.game is not None:
            self.game.on_game_event(event)
        if isinstance(event, GameVoiceChanged):
            if event.state != "busy" and (
                self.audience.pending_count() or self._game_events or self._vote_ended
            ):
                self._wake_if_live()
            return True
        if isinstance(event, SceneObserved | StepProgress):
            return True
        with self._events_lock:
            self._game_events.append(event)
        self._wake_if_live()
        return True

    def _has_urgent_work(self) -> bool:
        if self._vote_ended:
            return True
        with self._events_lock:
            return any(
                isinstance(event, DecisionNeeded | ControlReleased) for event in self._game_events
            )

    def notify_vote_ended(self) -> None:
        if not self._closed and self.game and self.game.link.pending_decision is not None:
            self._vote_ended = True
            self._wake_if_live()

    def notify_objective_resumed(self) -> None:
        if (
            not self._closed
            and self.game
            and self.game.link.connected
            and self.game.link.snapshot().active_goal_id is None
        ):
            self._objective_resumed = True
            self._wake_if_live()

    def _wake_if_live(self) -> None:
        if self.safety.snapshot().mode == HostMode.LIVE:
            if self._loop and self._thread != get_ident():
                self._loop.call_soon_threadsafe(self._schedule)
            else:
                self._schedule()

    def _schedule(self) -> None:
        if not self._closed and not self._timer and not self._turn:
            self._timer = asyncio.create_task(self._batch())

    async def _batch(self) -> None:
        await asyncio.sleep(self.config.batch_window_s)
        deadline = time.monotonic() + self.config.max_voice_defer_s
        while (
            not self._closed
            and self.safety.snapshot().mode == HostMode.LIVE
            and self.game is not None
            and self.game.voice_busy
            and not self._has_urgent_work()
            and time.monotonic() < deadline
        ):
            await asyncio.sleep(min(0.1, max(0.0, deadline - time.monotonic())))
        self._timer = None
        await self.run_once()

    async def run_once(self, trigger: str = "danmaku") -> DirectorResult:
        if self._timer:
            self._timer.cancel()
            self._timer = None
        if self._closed or self._turn or self.safety.snapshot().mode != HostMode.LIVE:
            return DirectorResult("skipped")
        await self.start()
        self._cancel = asyncio.Event()
        if self._vote_ended:
            self._vote_ended = False
            if self.game and self.game.link.pending_decision is not None:
                trigger = "vote_ended"
        elif self._objective_resumed:
            self._objective_resumed = False
            trigger = "objective_resumed"
        self._turn = asyncio.create_task(self._respond(trigger, self._cancel))
        try:
            return await self._turn
        except asyncio.CancelledError:
            return DirectorResult("interrupted")
        except Exception as exc:
            return DirectorResult("error", reason=type(exc).__name__)
        finally:
            self._turn = None
            if (
                self.audience.pending_count()
                or self._game_events
                or self._vote_ended
                or self._objective_resumed
            ):
                self._wake_if_live()

    async def _respond(self, trigger: str, cancel: asyncio.Event) -> DirectorResult:
        candidates = self.audience.drain_candidates()
        votes = self.audience.active_vote(), self.audience.last_ended_vote()
        with self._events_lock:
            events = tuple(self._game_events)
            self._game_events.clear()
        game = (
            self.game.director_context(events)
            if self.game and (self.game.link.connected or events)
            else None
        )
        pending = self.game.link.pending_decision if self.game else None
        messages = build_messages(
            self.config.persona, trigger, self.speech.recent_heard(), candidates, *votes, game=game
        )
        ids = {c.candidate_id for c in candidates}
        scanner, sent = IntentScanner(), 0
        queue = asyncio.Queue[str | None]()

        async def chunks() -> AsyncIterator[str]:
            while (part := await queue.get()) is not None:
                yield part

        playback = reply = None
        game_task: asyncio.Task[CommandAck | None] | None = None
        stream = self.llm.stream_chat(messages, cancel=cancel)
        try:
            async for delta in stream:
                scanner.feed(delta)
                text = scanner.text[sent : self.config.max_speak_chars]
                if scanner.action == "speak" and text:
                    if playback is None:
                        reply = scanner.reply_to
                        if reply is not None and reply not in ids:
                            raise ValueError("unknown reply target")
                        req = SpeechRequest(uuid4().hex, chunks(), reply_to=reply)
                        playback = asyncio.create_task(self.speech.speak(req))
                    queue.put_nowait(text)
                    sent += len(text)
            obj: dict[str, object] = json.loads(scanner.raw)
            if cancel.is_set():
                return DirectorResult("interrupted")
            fields = obj.keys()
            if playback and fields <= {"action", "replyTo", "text", "game"}:
                if reply != scanner.reply_to or obj.get("text") != scanner.text:
                    raise ValueError("inconsistent speech intent")
                queue.put_nowait(None)
                if obj.get("game") is not None:
                    game_task = asyncio.create_task(self._dispatch_game(obj["game"], pending))
                outcome = await playback
                if cancel.is_set():
                    return DirectorResult("interrupted")
                game_ack = await game_task if game_task else None
                if outcome.status == "completed":
                    return DirectorResult(
                        "speak", scanner.text[:sent], scanner.reply_to, game_ack=game_ack
                    )
                action = "interrupted" if outcome.status == "interrupted" else "error"
                return DirectorResult(action, reason=outcome.reason, game_ack=game_ack)
            if scanner.action == "silence" and fields <= {"action", "reason", "game"}:
                reason = obj.get("reason", "")
                if isinstance(reason, str):
                    ack = await self._dispatch_game(obj.get("game"), pending)
                    return DirectorResult("silence", reason=reason, game_ack=ack)
            if scanner.action == "vote":
                vote, opening = self.audience.start_vote_fields(obj)
                task = asyncio.create_task(self._announce_end(vote))
                self._votes.add(task)
                task.add_done_callback(self._votes.discard)
                await self.speech.speak(SpeechRequest(uuid4().hex, opening))
                return DirectorResult("interrupted" if cancel.is_set() else "vote", opening)
            raise ValueError("invalid intent")
        finally:
            for task in (game_task, playback):
                if task and not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
            if isinstance(stream, AsyncGenerator):
                await stream.aclose()

    async def _dispatch_game(
        self, raw_game: object, observed: DecisionNeeded | None
    ) -> CommandAck | None:
        if raw_game is None or self.game is None:
            return None
        if not isinstance(raw_game, dict):
            return CommandAck(False, "invalid_game_directive")
        fields = cast(dict[str, object], raw_game)
        try:
            if fields.get("command") == "resolve_decision":
                pending = self.game.link.pending_decision
                if pending is None:
                    return CommandAck(False, "no_pending_decision")
                if pending != observed:
                    return CommandAck(False, "decision_mismatch")
                command = parse_game_directive(fields, pending_decision=pending)
            else:
                command = parse_game_directive(fields)
        except ValueError:
            return CommandAck(False, "invalid_game_directive")
        try:
            return await self.game.dispatch(command, source=IntentSource.AGENT, holder="director")
        except (SafetyError, ChannelError, RpcError, ProtocolError) as exc:
            return CommandAck(False, str(exc) or type(exc).__name__)

    async def _announce_end(self, vote: VoteSnapshot) -> None:
        if result := await self.audience.close_at_deadline(vote):
            await self.speech.speak(SpeechRequest(uuid4().hex, result[1]))
            self.notify_vote_ended()

    def interrupt(self, reason: str = "operator_interrupt") -> None:
        self.speech.interrupt(reason)
        turn, event = self._turn, self._cancel

        def stop() -> None:
            if turn and not event.is_set():
                event.set()
                turn.cancel()
            if self._timer:
                self._timer.cancel()
                self._timer = None

        if self._loop and self._thread != get_ident():
            self._loop.call_soon_threadsafe(stop)
        else:
            stop()

    async def quiesce(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._off()
        pending = [t for t in (self._turn, self._timer) if t]
        self.interrupt("closed")
        for task in self._votes:
            task.cancel()
        await asyncio.gather(*self._votes, *pending, return_exceptions=True)

    close = quiesce
