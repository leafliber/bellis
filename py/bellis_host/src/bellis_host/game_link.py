"""Host endpoint for goals, pacing commands and game outcomes."""

import asyncio
import os
import secrets
from collections.abc import Callable
from contextlib import AsyncExitStack, suppress
from dataclasses import dataclass

from bellis_common import agent_events as ev
from bellis_common import channel as ch
from bellis_common import cred
from bellis_common.agent_events import AgentLinkMethods as Methods
from bellis_common.permit_messages import Empty
from bellis_common.wire_codec import ProtocolError


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
    pending_decision: ev.DecisionNeeded | None
    last_highlight: str | None
    voice_state: str = "unknown"


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
        self._pending_decision: ev.DecisionNeeded | None = None
        self._last_highlight: str | None = None
        self._last_outcome: ev.LoopOutcome | None = None
        self._voice_state = "unknown"
        self.last_event: ev.FastEvent | None = None
        self._paused = self._closed = False
        self._commands = asyncio.Lock()
        self._lifecycle = asyncio.Lock()

    @property
    def connected(self) -> bool:
        return self._hello is not None and self._peer is not None and self._peer.connection.is_open

    @property
    def pending_decision(self) -> ev.DecisionNeeded | None:
        return self._pending_decision

    @property
    def voice_busy(self) -> bool:
        return self._voice_state == "busy"

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
        if isinstance(event, ev.GameVoiceChanged):
            self._voice_state = event.state
            if self._on_event:
                self._on_event(event)
            return
        active = self._goal and self._goal.goal_id == event.goal_id
        starting = self._pending_goal and self._pending_goal.goal_id == event.goal_id
        if isinstance(event, ev.GoalCompleted | ev.GoalStuck | ev.ControlReleased):
            self._last_outcome = event
            if active:
                self._goal = None
            if starting:
                self._pending_goal = None
            if self._pending_decision and self._pending_decision.goal_id == event.goal_id:
                self._pending_decision = None
        elif active or starting:
            if isinstance(event, ev.DecisionNeeded):
                self._pending_decision = event
            else:
                self._last_highlight = event.summary
        if self._on_event:
            self._on_event(event)

    def _disconnect(self, peer: ch.RpcPeer) -> None:
        if self._peer is not peer:
            return
        had_hello = self._hello is not None
        self._peer = self._hello = self._goal = self._pending_goal = None
        self._pending_decision = self._last_highlight = None
        self._voice_state = "unknown"
        self._paused = False
        if had_hello and self._on_connection:
            self._on_connection(False)

    async def send_command(self, command: ev.SlowCommand) -> ev.CommandAck:
        async with self._commands:
            peer = self._peer
            if peer is None or not self.connected:
                raise ch.ChannelError("closed", "game-agent is not connected")
            self._pending_goal = command if isinstance(command, ev.GoalSet) else None
            if self._pending_goal and self._goal is None:
                self._pending_decision = None
            try:
                reply = await peer.request(Methods.HOST_COMMAND, command.to_dict())
                ack = ev.CommandAck.from_dict(reply)
                if peer is not self._peer:
                    return ack
                pending = self._pending_decision
                if isinstance(command, ev.GoalCancel) and (ack.accepted or ack.reason == "idle"):
                    if ack.reason == "idle":
                        self._goal = None
                    if pending and command.goal_id in (None, pending.goal_id):
                        self._pending_decision = None
                if isinstance(command, ev.DecisionResolved) and (
                    ack.reason in {"idle", "no_pending_decision"}
                    or (ack.accepted and pending and pending.decision_id == command.decision_id)
                ):
                    self._pending_decision = None
                if ack.accepted:
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

    def snapshot(self) -> GameLinkSnapshot:
        hello, goal, event = self._hello, self._goal or self._pending_goal, self._last_outcome
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
            event and event.TAG, detail, self._pending_decision, self._last_highlight,
            self._voice_state,
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
