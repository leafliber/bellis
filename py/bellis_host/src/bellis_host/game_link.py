"""Host endpoint for goals, pacing commands and game outcomes."""

import asyncio
import os
import secrets
from collections.abc import Callable, Sequence
from contextlib import AsyncExitStack, suppress
from dataclasses import asdict, dataclass
from typing import cast
from uuid import uuid4

from bellis_common import agent_events as ev
from bellis_common import channel as ch
from bellis_common import cred
from bellis_common.agent_events import AgentLinkMethods as Methods
from bellis_common.permit_messages import Empty
from bellis_common.wire_codec import ProtocolError

from .safety import EmergencySummary, IntentRequest, SafetyCore, SafetyError
from .store import HostStore, IntentSource, IntentState


def parse_game_directive(raw: object) -> ev.SlowCommand:
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
    if command == "cancel_goal":
        defaults = ev.GoalCancel().to_dict()
    elif command == "pause_pacing":
        defaults = ev.PacingPause().to_dict()
    elif command == "resume_pacing":
        defaults = ev.PacingResume().to_dict()
    else:
        raise ValueError("unknown game command")
    return ev.parse_slow_command({**defaults, **fields})


@dataclass(frozen=True, slots=True)
class GameLinkConfig:
    cred_target: str | None = None
    rpc_timeout_s: float = 2.0
    session_id: str | None = None

    def __post_init__(self) -> None:
        if not ev.positive_time(self.rpc_timeout_s):
            raise ValueError("rpc_timeout_s must be finite and positive")
        target = self.cred_target
        if target is not None and (type(target) is not str or not target.strip() or "\0" in target):
            raise ValueError("invalid game link credential target")


@dataclass(frozen=True, slots=True)
class GameLinkSnapshot:
    connected: bool
    game_id: str | None
    display_name: str | None
    active_goal_id: str | None
    active_goal_description: str | None
    paused: bool
    last_outcome: str | None
    last_outcome_detail: str | None


class HostGameLink:
    def __init__(
        self,
        config: GameLinkConfig = GameLinkConfig(),
        *,
        on_event: Callable[[ev.FastEvent], None] | None = None,
        on_connection: Callable[[bool], None] | None = None,
    ) -> None:
        self._config = config
        self._on_event, self._on_connection = on_event, on_connection
        sid = config.session_id or secrets.token_hex(6)
        self.credentials = ch.ChannelCredentials(
            ch.create_channel_path(sid), ch.create_session_key()
        )
        self._info = cred.SessionInfo.create(self.credentials, sid, launcher_pid=os.getpid())
        self.session_info: cred.SessionInfo | None = None
        self._resources = AsyncExitStack()
        self._peer: ch.RpcPeer | None = None
        self._hello: ev.AgentHelloParams | None = None
        self._goal: ev.GoalSet | None = None
        self._pending_goal: ev.GoalSet | None = None
        self.last_event: ev.FastEvent | None = None
        self._paused = self._closed = False
        self._connected_event = asyncio.Event()
        self._commands = asyncio.Lock()
        self._lifecycle = asyncio.Lock()

    @property
    def connected(self) -> bool:
        return self._hello is not None and self._peer is not None and self._peer.connection.is_open

    async def start(self) -> cred.SessionInfo:
        async with self._lifecycle:
            if self._closed or self.session_info is not None:
                raise RuntimeError("game link cannot start")
            async with AsyncExitStack() as opening:
                server = await ch.listen(
                    self.credentials.path,
                    self.credentials.key,
                    on_connection=self._accept,
                    on_rejected=lambda _: None,
                    on_error=lambda _: None,
                )
                opening.push_async_callback(server.close)
                if (target := self._config.cred_target) is not None:
                    cred.write_session_info(self._info, target)
                    opening.callback(self._unpublish, target)
                self._resources = opening.pop_all()
            self.session_info = self._info
            return self._info

    async def wait_connected(self, timeout: float | None = None) -> None:
        async with asyncio.timeout(timeout):
            await self._connected_event.wait()

    def _accept(self, conn: ch.Connection) -> None:
        if self._closed or conn.role != ev.GAME_AGENT_ROLE or self._peer is not None:
            conn.abort()
            return
        peer = self._peer = ch.RpcPeer(conn, timeout=self._config.rpc_timeout_s)
        peer.handle(Methods.AGENT_HELLO, self._receive_hello)
        peer.on_notification(Methods.GAME_EVENT, self._receive_event)
        peer.closed.add_done_callback(lambda _: self._disconnect(peer))

    def _receive_hello(self, raw: object) -> dict[str, object]:
        if self._closed or self._hello is not None:
            raise ch.RpcError(ch.RpcErrorCode.INVALID_REQUEST, "unexpected agent hello")
        try:
            self._hello = ev.AgentHelloParams.from_dict(raw)
        except ProtocolError as exc:
            raise ch.RpcError(ch.RpcErrorCode.INVALID_PARAMS, str(exc)) from exc
        self._connected_event.set()
        if self._on_connection:
            self._on_connection(True)
        return Empty().to_dict()

    def _receive_event(self, raw: object) -> None:
        if not self.connected:
            return
        try:
            event = ev.parse_fast_event(raw)
        except ProtocolError:
            return
        self.last_event = event
        if self._goal and self._goal.goal_id == event.goal_id:
            self._goal = None
        elif self._pending_goal and self._pending_goal.goal_id == event.goal_id:
            self._pending_goal = None
        if self._on_event:
            self._on_event(event)

    def _disconnect(self, peer: ch.RpcPeer) -> None:
        if self._peer is not peer:
            return
        had_hello = self._hello is not None
        self._peer = self._hello = self._goal = self._pending_goal = None
        self._paused = False
        self._connected_event.clear()
        if had_hello and self._on_connection:
            self._on_connection(False)

    async def send_command(self, command: ev.SlowCommand) -> ev.CommandAck:
        async with self._commands:
            peer = self._peer
            if peer is None or not self.connected:
                raise ch.ChannelError("closed", "game-agent is not connected")
            self._pending_goal = command if isinstance(command, ev.GoalSet) else None
            try:
                reply = await peer.request(Methods.HOST_COMMAND, command.to_dict())
                ack = ev.CommandAck.from_dict(reply)
                if (
                    isinstance(command, ev.GoalCancel)
                    and ack == ev.CommandAck(False, "idle")
                    and peer is self._peer
                ):
                    self._goal = None
                if ack.accepted and peer is self._peer:
                    if self._pending_goal:
                        self._goal = self._pending_goal
                    elif isinstance(command, (ev.PacingPause, ev.PacingResume)):
                        self._paused = isinstance(command, ev.PacingPause)
                return ack
            except (asyncio.CancelledError, ch.ChannelError, ProtocolError):
                # An unacknowledged goal may already be running on the peer.
                if peer is self._peer and self._pending_goal and self._goal is None:
                    self._goal = self._pending_goal
                raise
            finally:
                self._pending_goal = None

    async def set_goal(self, goal: ev.GoalSet) -> ev.CommandAck:
        return await self.send_command(goal)

    async def cancel_goal(
        self, goal_id: str | None = None, *, reason: str = "cancelled"
    ) -> ev.CommandAck:
        return await self.send_command(ev.GoalCancel(goal_id, reason))

    async def pause_pacing(self, *, reason: str = "pacing") -> ev.CommandAck:
        return await self.send_command(ev.PacingPause(reason))

    async def resume_pacing(self, *, reason: str = "resumed") -> ev.CommandAck:
        return await self.send_command(ev.PacingResume(reason))

    def snapshot(self) -> GameLinkSnapshot:
        hello, goal, event = self._hello, self._goal or self._pending_goal, self.last_event
        detail = None
        if isinstance(event, ev.GoalCompleted):
            detail = event.evidence
        elif isinstance(event, ev.GoalStuck):
            detail = f"{event.reason}: {event.detail}"
        elif isinstance(event, ev.ControlReleased):
            detail = f"{event.reason.value} ({event.verification.value})"
        return GameLinkSnapshot(
            self.connected, hello and hello.game_id, hello and hello.display_name,
            goal and goal.goal_id, goal and goal.description, self._paused,
            event and event.TAG, detail,
        )  # fmt: skip

    def _unpublish(self, target: str) -> None:
        with suppress(cred.CredError):
            if cred.read_session_info(target) == self._info:
                cred.delete_session_info(target)

    async def close(self) -> None:
        async with self._lifecycle:
            self._closed = True
            try:
                if self._peer:
                    await self._peer.close()
            finally:
                await self._resources.aclose()


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

    async def set_goal(self, goal: ev.GoalSet) -> ev.CommandAck:
        return await self.dispatch(goal)

    async def cancel_goal(
        self, goal_id: str | None = None, *, reason: str = "cancelled"
    ) -> ev.CommandAck:
        return await self.dispatch(ev.GoalCancel(goal_id, reason))

    async def pause_pacing(self, *, reason: str = "pacing") -> ev.CommandAck:
        return await self.dispatch(ev.PacingPause(reason))

    async def resume_pacing(self, *, reason: str = "resumed") -> ev.CommandAck:
        return await self.dispatch(ev.PacingResume(reason))

    async def cancel_for_stop(self, reason: str = "host_stopped") -> None:
        if self.link.connected and self.link.snapshot().active_goal_id is not None:
            if self._cancel_task is None or self._cancel_task.done():
                self._cancel_task = asyncio.create_task(self._cancel_goal(reason))
            await asyncio.shield(self._cancel_task)

    async def _cancel_goal(self, reason: str) -> None:
        with suppress(ch.ChannelError, ch.RpcError, ProtocolError):
            await self.link.cancel_goal(None, reason=reason)

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
