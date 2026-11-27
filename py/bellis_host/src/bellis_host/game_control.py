"""Authorize and journal game directives from the director and operator."""

import asyncio
from collections.abc import Callable, Sequence
from contextlib import suppress
from dataclasses import asdict
from typing import cast
from uuid import uuid4

from bellis_common import agent_events as ev
from bellis_common import channel as ch
from bellis_common.wire_codec import ProtocolError

from .game_link import HostGameLink
from .safety import EmergencySummary, IntentRequest, SafetyCore, SafetyError
from .store import HostStore, IntentSource, IntentState


def parse_game_directive(
    raw: object, *, pending_decision: ev.DecisionNeeded | None = None
) -> ev.SlowCommand:
    if not isinstance(raw, dict):
        raise ValueError("expected game directive object")
    if not all(isinstance(key, str) for key in cast(dict[object, object], raw)):
        raise ValueError("expected string keys")
    fields = cast(dict[str, object], raw).copy()
    command = fields.pop("command", None)
    if "type" in fields:
        raise ValueError("invalid directive field")
    for value in fields.values():
        if isinstance(value, str):
            value.encode("utf-8")
    if command == "set_goal":
        timeout = fields.get("timeout_s", 90.0)
        if not isinstance(timeout, int | float) or not 5 <= timeout <= 180:
            raise ValueError("timeout_s must be between 5 and 180")
        fields.setdefault("goal_id", uuid4().hex)
        fields.setdefault("max_steps", 8)
        goal = ev.GoalSet.from_dict({"type": ev.GoalSet.TAG, "timeout_s": timeout, **fields})
        if goal.max_steps > 20:
            raise ValueError("max_steps must be between 1 and 20")
        return goal
    if command == "resolve_decision":
        fields.setdefault("reason", "")
        if pending_decision is not None:
            index = fields.get("chosen_index")
            if fields.setdefault("goal_id", pending_decision.goal_id) != pending_decision.goal_id:
                raise ValueError("goal_mismatch")
            if (
                fields.setdefault("decision_id", pending_decision.decision_id)
                != pending_decision.decision_id
            ):
                raise ValueError("decision_mismatch")
            if type(index) is not int or not 0 <= index < len(pending_decision.options):
                raise ValueError("chosen_index out of range")
            option = pending_decision.options[index]
            if fields.setdefault("chosen_option", option) != option:
                raise ValueError("option_mismatch")
        return ev.DecisionResolved.from_dict({"type": ev.DecisionResolved.TAG, **fields})
    if command == "cancel_goal":
        defaults = ev.GoalCancel().to_dict()
    elif command == "pause_pacing":
        defaults = ev.PacingPause().to_dict()
    elif command == "resume_pacing":
        defaults = ev.PacingResume().to_dict()
    else:
        raise ValueError("unknown game command")
    return ev.parse_slow_command({**defaults, **fields})


class GameController:
    def __init__(
        self,
        safety: SafetyCore,
        store: HostStore,
        link: HostGameLink,
        *,
        permit_armed: Callable[[], bool] | None = None,
    ):
        self._safety, self._store, self.link = safety, store, link
        self._permit_armed = permit_armed
        self._off: Callable[[], None] | None = None
        self._stops: set[asyncio.Task[None]] = set()
        self._cancel_task: asyncio.Task[None] | None = None
        self._admission = asyncio.Lock()
        self._closed = False

    def start(self) -> None:
        if self._off or self._closed:
            return
        loop = asyncio.get_running_loop()

        def stop() -> None:
            task = asyncio.create_task(self.cancel_for_stop("emergency"))
            self._stops.add(task)
            task.add_done_callback(self._stops.discard)

        def emergency(_: EmergencySummary) -> None:
            loop.call_soon_threadsafe(stop)

        self._off = self._safety.on_emergency(emergency)

    async def dispatch(
        self,
        command: ev.SlowCommand,
        *,
        source: IntentSource = IntentSource.AGENT,
        holder: str = "director",
    ) -> ev.CommandAck:
        async with self._admission:
            if not self.link.connected:
                raise ch.ChannelError("closed", "game-agent is not connected")
            if self._closed:
                raise SafetyError("closed")
            stopping = isinstance(command, ev.GoalCancel | ev.PacingPause)
            caps = frozenset({"game.stop" if stopping else "game.control"})
            request = IntentRequest(
                holder,
                f"game:{command.TAG}:{uuid4().hex}",
                f"game.{command.TAG}",
                "game.link",
                command.to_dict(),
                source,
                caps,
                time_sensitive=True,
            )
            decision = self._safety.authorize_intent(request)
            if not decision.allowed or decision.intent is None:
                raise SafetyError(decision.reason)
            intent_id = decision.intent.id
            self._store.mark_executing(intent_id)
            try:
                ack = await self.link.send_command(command)
            except (ch.ChannelError, ch.RpcError, ProtocolError, asyncio.CancelledError) as exc:
                self._store.finish_intent(intent_id, IntentState.UNKNOWN, error=type(exc).__name__)
                raise
            self._store.finish_intent(
                intent_id,
                IntentState.SUCCEEDED if ack.accepted else IntentState.FAILED,
                result=ack.to_dict(),
                error=None if ack.accepted else ack.reason,
            )
            return ack

    async def resolve_decision(
        self,
        chosen_index: int,
        *,
        decision_id: str | None = None,
        reason: str = "",
        source: IntentSource = IntentSource.AGENT,
        holder: str = "director",
    ) -> ev.CommandAck:
        if not self.link.connected:
            raise ch.ChannelError("closed", "game-agent is not connected")
        if self._closed:
            raise SafetyError("closed")
        if type(chosen_index) is not int or not 0 <= chosen_index <= 3:
            raise ValueError("chosen_index out of range")
        pending = self.link.pending_decision
        if pending is None:
            return ev.CommandAck(False, "no_pending_decision")
        if decision_id is not None and decision_id != pending.decision_id:
            return ev.CommandAck(False, "decision_mismatch")
        if chosen_index >= len(pending.options):
            raise ValueError("chosen_index out of range")
        command = ev.DecisionResolved(
            pending.goal_id,
            pending.decision_id,
            chosen_index,
            pending.options[chosen_index],
            reason,
        )
        return await self.dispatch(command, source=source, holder=holder)

    async def cancel_for_stop(self, reason: str = "host_stopped") -> None:
        if self.link.connected and self.link.snapshot().active_goal_id is not None:
            if self._cancel_task is None or self._cancel_task.done():
                self._cancel_task = asyncio.create_task(self._cancel_goal(reason))
            await asyncio.shield(self._cancel_task)

    async def _cancel_goal(self, reason: str) -> None:
        with suppress(ch.ChannelError, ch.RpcError, ProtocolError):
            await self.link.send_command(ev.GoalCancel(None, reason))

    @property
    def voice_busy(self) -> bool:
        return self.link.voice_busy

    def director_context(self, events: Sequence[ev.FastEvent]) -> dict[str, object]:
        return {
            "snapshot": asdict(self.link.snapshot()),
            "permit_armed": bool(self._permit_armed and self._permit_armed()),
            "events": [event.to_dict() for event in events],
        }

    async def close(self) -> None:
        self._closed = True
        if self._off:
            self._off()
            self._off = None
        await asyncio.sleep(0)  # Admit queued emergency callbacks before closing the pipe.
        await asyncio.gather(*self._stops, return_exceptions=True)
        if self._cancel_task:
            await asyncio.gather(self._cancel_task, return_exceptions=True)
