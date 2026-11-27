"""Run successive bounded goals on one authenticated Host connection."""

import asyncio
from collections.abc import Callable
from contextlib import AsyncExitStack, suppress
from dataclasses import dataclass

from bellis_common import agent_events as ev
from bellis_common import channel as ch
from bellis_common.agent_events import AgentLinkMethods as Methods
from bellis_common.cred import read_session_info
from bellis_common.permit_messages import Empty, InputReleasedParams, Producer
from bellis_common.telemetry import JsonlTelemetry
from bellis_common.wire_codec import ProtocolError

from bellis_game.io.protocol import ActionReceiptParams
from bellis_game.perception import GameProfile
from bellis_game.skills import ActionExecutor, FrameReader

from .agent import FastLoop, LoopConfig, LoopControl, LoopCore, VisionModel, VoiceMonitor
from .events import ActionRecord


def _observe[**P](callback: Callable[P, None] | None, *args: P.args, **kwargs: P.kwargs) -> None:
    if callback is not None:
        with suppress(Exception):
            callback(*args, **kwargs)


@dataclass(frozen=True, slots=True)
class GameSessionConfig:
    link_cred_target: str | None = ev.DEFAULT_GAME_LINK_TARGET
    link_credentials: ch.ChannelCredentials | None = None
    rpc_timeout_s: float = 2.0
    producer_id: str = ev.GAME_AGENT_ROLE
    loop_config: LoopConfig = LoopConfig()

    def __post_init__(self) -> None:
        if not ev.positive_time(self.rpc_timeout_s):
            raise ValueError("rpc_timeout_s must be finite and positive")
        if type(self.producer_id) is not str or not self.producer_id.strip():
            raise ValueError("producer_id must be non-empty")
        if self.link_credentials is None and not self.link_cred_target:
            raise ValueError("game link credentials or target required")

    def credentials(self) -> ch.ChannelCredentials:
        if self.link_credentials is not None:
            return self.link_credentials
        assert self.link_cred_target is not None
        info = read_session_info(self.link_cred_target)
        if info is None:
            raise ch.ChannelError("connect-failed", "game link credential missing")
        return info.credentials()


class GameSession:
    def __init__(
        self,
        core: LoopCore,
        frames: FrameReader,
        vlm: VisionModel,
        profile: GameProfile,
        config: GameSessionConfig = GameSessionConfig(),
        *,
        telemetry: JsonlTelemetry | None = None,
        voice: VoiceMonitor | None = None,
        on_step: Callable[[ActionRecord], None] | None = None,
        on_connected: Callable[[], None] | None = None,
        on_command: Callable[[ev.SlowCommand, ev.CommandAck], None] | None = None,
        on_event: Callable[[ev.FastEvent], None] | None = None,
    ) -> None:
        self._core, self._frames, self._vlm, self._profile = core, frames, vlm, profile
        self._config, self._telemetry, self._voice = config, telemetry, voice
        self._on_step = on_step
        self._on_connected, self._on_command, self._on_event = on_connected, on_command, on_event
        self._generation = 0
        self._executor: ActionExecutor | None = None
        self._control: LoopControl | None = None
        self._goal_id: str | None = None
        self._peer: ch.RpcPeer | None = None
        self._paused = self._closed = False
        self._goals = asyncio.TaskGroup()
        self._finished = asyncio.Event()
        self._finished.set()

    def _next_producer(self) -> Producer:
        self._generation += 1
        return Producer(self._config.producer_id, self._generation)

    def on_receipt(self, rec: ActionReceiptParams) -> None:
        if self._executor:
            self._executor.on_receipt(rec)

    def on_released(self, rel: InputReleasedParams) -> None:
        if self._executor:
            self._executor.on_released(rel)

    def on_voice_changed(self, state: str, reason: str = "") -> None:
        self._emit_event(ev.GameVoiceChanged(state, reason))

    async def run(self) -> None:
        if self._closed or not self._finished.is_set():
            raise RuntimeError("game session cannot start")
        self._finished.clear()
        try:
            async with AsyncExitStack() as stack:
                creds = self._config.credentials()
                conn = await ch.connect(creds.path, ev.GAME_AGENT_ROLE, creds.key)
                peer = self._peer = ch.RpcPeer(conn, timeout=self._config.rpc_timeout_s)
                stack.push_async_callback(peer.close)
                if self._closed:
                    return
                await stack.enter_async_context(self._goals)
                stack.callback(self._disconnect)
                peer.handle(Methods.HOST_COMMAND, self._handle_command)
                hello = ev.AgentHelloParams(self._profile.game_id, self._profile.display_name)
                try:
                    Empty.from_dict(await peer.request(Methods.AGENT_HELLO, hello.to_dict()))
                except ch.ChannelError:
                    if self._closed:
                        return
                    raise
                _observe(self._on_connected)
                await asyncio.shield(peer.closed)
        finally:
            self._closed = True
            self._finished.set()

    def _disconnect(self) -> None:
        self._closed = True
        if self._control:
            self._control.cancel("host_disconnected")

    def _handle_command(self, raw: object) -> dict[str, object]:
        try:
            cmd = ev.parse_slow_command(raw)
        except ProtocolError as exc:
            raise ch.RpcError(ch.RpcErrorCode.INVALID_PARAMS, str(exc)) from exc
        ack = self._apply_command(cmd)
        _observe(self._on_command, cmd, ack)
        return ack.to_dict()

    def _apply_command(self, cmd: ev.SlowCommand) -> ev.CommandAck:
        if self._closed:
            return ev.CommandAck(False, "closed")
        if isinstance(cmd, ev.GoalSet):
            if self._control:
                return ev.CommandAck(False, "busy")
            producer = self._next_producer()
            self._executor = ActionExecutor(self._core, self._frames, self._profile, producer)
            loop = FastLoop(
                self._core, self._frames, self._vlm, self._executor, self._profile, producer,
                config=self._config.loop_config, telemetry=self._telemetry, voice=self._voice,
                on_step=lambda record: _observe(self._on_step, record),
                on_event=self._emit_event,
            )  # fmt: skip
            self._control = LoopControl()
            if self._paused:
                self._control.pause()
            self._goal_id = cmd.goal_id
            self._goals.create_task(self._run_goal(cmd, loop, self._control))
        elif isinstance(cmd, ev.GoalCancel | ev.DecisionResolved):
            if self._control is None:
                return ev.CommandAck(False, "idle")
            if cmd.goal_id is not None and cmd.goal_id != self._goal_id:
                return ev.CommandAck(False, "goal_mismatch")
            if isinstance(cmd, ev.DecisionResolved):
                error = self._control.resolve_decision(cmd)
                return ev.CommandAck(error is None, error or "")
            self._control.cancel(cmd.reason)
        else:
            self._paused = isinstance(cmd, ev.PacingPause)
            if self._control:
                if self._paused:
                    self._control.pause()
                else:
                    self._control.resume()
        return ev.CommandAck(True)

    async def _run_goal(self, goal: ev.GoalSet, loop: FastLoop, control: LoopControl) -> None:
        try:
            outcome = await loop.run_goal(goal, control=control, next_producer=self._next_producer)
        except Exception as exc:
            outcome = ev.GoalStuck(goal.goal_id, "loop_error", type(exc).__name__, 0, None)
        finally:
            self._control = self._executor = self._goal_id = None
        self._emit_event(outcome)

    def _emit_event(self, event: ev.FastEvent) -> None:
        if self._peer and self._peer.connection.is_open:
            with suppress(ch.ChannelError):
                self._peer.notify(Methods.GAME_EVENT, event.to_dict())
        _observe(self._on_event, event)

    async def close(self) -> None:
        self._disconnect()
        if self._peer:
            await self._peer.close()
        await self._finished.wait()

    quiesce = close
