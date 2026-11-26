import asyncio
import json
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from bellis_common import agent_events as ev
from bellis_common import channel as ch
from bellis_common import cred
from bellis_common.cred import DEFAULT_SESSION_TARGET, SessionInfo
from bellis_common.wire_codec import ProtocolError
from bellis_game.io import protocol as rpc
from bellis_game.loop import GameSession, GameSessionConfig, LoopConfig, cli
from bellis_host import GameLinkConfig, HostGameLink
from test_fast_loop import DONE, PROFILE, RELEASE, WAIT, Frames, Model

GOAL = ev.GoalSet("map", "Open the map")
COMPLETED = ev.GoalCompleted("map", "visible", 1, 1)
STUCK = ev.GoalStuck("map", "stop", "unknown", 0, None)
RELEASED = ev.ControlReleased("map", RELEASE.reason, RELEASE.verification, 0)
ACK = ev.CommandAck(True)


def test_event_contract() -> None:
    for cmd in (GOAL, ev.GoalCancel(), ev.PacingPause(), ev.PacingResume()):
        assert ev.parse_slow_command(cmd.to_dict()) == cmd
    for event in (COMPLETED, STUCK, RELEASED):
        assert ev.parse_fast_event(event.to_dict()) == event
    for raw in (
        {"type": "unknown"},
        {"type": GOAL.TAG},
        dict(GOAL.to_dict(), extra=True),
        dict(GOAL.to_dict(), max_steps=True),
        dict(GOAL.to_dict(), timeout_s=-1),
    ):
        with pytest.raises(ProtocolError):
            ev.parse_slow_command(raw)
    for raw in (
        dict(STUCK.to_dict(), steps_taken=-1),
        dict(COMPLETED.to_dict(), last_frame=True),
        dict(RELEASED.to_dict(), verification="unknown"),
    ):
        with pytest.raises(ProtocolError):
            ev.parse_fast_event(raw)


async def connect(link: HostGameLink, role: str = ev.GAME_AGENT_ROLE) -> ch.RpcPeer:
    creds = link.credentials
    return ch.RpcPeer(await ch.connect(creds.path, role, creds.key), timeout=2)


@pytest.mark.parametrize("replaced", [False, True])
async def test_link_handshake_and_credential_ownership(
    monkeypatch: pytest.MonkeyPatch,
    replaced: bool,
) -> None:
    store: dict[str, SessionInfo] = {}

    def write(info: SessionInfo, target: str) -> None:
        store[target] = info

    monkeypatch.setattr(cred, "write_session_info", write)
    monkeypatch.setattr(cred, "read_session_info", store.get)
    monkeypatch.setattr(cred, "delete_session_info", store.pop)
    connections: list[bool] = []
    link = HostGameLink(GameLinkConfig("link"), on_connection=connections.append)
    info = await link.start()
    async with asyncio.timeout(5):
        try:
            wrong_role = await connect(link, "observer")
            await wrong_role.closed
            peer = await connect(link)
            await (await connect(link)).closed
            peer.notify(ev.AgentLinkMethods.GAME_EVENT, COMPLETED.to_dict())
            with pytest.raises(ch.RpcError):
                await peer.request(ev.AgentLinkMethods.AGENT_HELLO, {})
            assert not link.connected and link.last_event is None
            with pytest.raises(ch.ChannelError, match="not connected"):
                await link.set_goal(GOAL)
            hello = ev.AgentHelloParams("hsr", "HSR")
            await peer.request(ev.AgentLinkMethods.AGENT_HELLO, hello.to_dict())
            await link.wait_connected(1)
            await (await connect(link)).closed

            def complete_before_ack(raw: object) -> dict[str, object]:
                assert ev.parse_slow_command(raw) == GOAL
                peer.notify(ev.AgentLinkMethods.GAME_EVENT, COMPLETED.to_dict())
                peer.notify(ev.AgentLinkMethods.GAME_EVENT, {})
                return ACK.to_dict()

            peer.handle(ev.AgentLinkMethods.HOST_COMMAND, complete_before_ack)
            assert await link.set_goal(GOAL) == ACK
            assert link.last_event == COMPLETED and link.snapshot().active_goal_id is None
            assert store["link"] == info
            if replaced:
                store["link"] = replace(info, session_id="other")
        finally:
            await link.close()
            await link.close()
        assert connections == [True, False] and not link.connected
        assert ("link" in store) == replaced


class Core:
    def __init__(self) -> None:
        self.beats: list[int] = []
        self.revoked: list[int] = []
        self.release = asyncio.Event()
        self.session: GameSession

    def send_heartbeat(self, producer: rpc.Producer, seq: int) -> None:
        self.beats.append(producer.generation)

    async def revoke_producer(self, generation: int) -> rpc.ProducerRevokeResult:
        self.revoked.append(generation)
        self.session.on_released(
            replace(
                RELEASE,
                reason=rpc.ReleaseReason.GENERATION_REVOKED,
                producer=rpc.Producer(ev.GAME_AGENT_ROLE, generation),
                verification=rpc.ReleaseVerification.UNVERIFIED,
            )
        )
        self.release.set()
        return rpc.ProducerRevokeResult(None)

    async def submit_action_block(self, block: rpc.ActionBlock) -> rpc.ActionSubmitResult:
        raise AssertionError("unexpected physical input")


@asynccontextmanager
async def running(
    model: Model,
) -> AsyncGenerator[tuple[HostGameLink, Core, asyncio.Queue[ev.FastEvent]]]:
    events: asyncio.Queue[ev.FastEvent] = asyncio.Queue()
    link = HostGameLink(on_event=events.put_nowait)
    await link.start()
    core = Core()
    config = GameSessionConfig(
        link_credentials=link.credentials, loop_config=LoopConfig(max_frame_age_s=30)
    )
    core.session = GameSession(core, Frames(), model, PROFILE, config)
    run = asyncio.create_task(core.session.run())
    try:
        async with asyncio.timeout(5):
            await link.wait_connected(2)
            snap = link.snapshot()
            assert (snap.game_id, snap.display_name) == (PROFILE.game_id, PROFILE.display_name)
            yield link, core, events
    finally:
        await link.close()
        await asyncio.wait_for(run, 2)
        assert not link.connected


async def test_successive_goals_and_disconnect() -> None:
    model = Model((DONE, {"action": "stop", "reason": "unknown", "detail": "menu"}))
    async with running(model) as (link, core, events):
        assert await link.set_goal(GOAL) == ACK
        assert isinstance(await events.get(), ev.GoalCompleted)
        assert await link.set_goal(GOAL) == ACK
        assert await events.get() == ev.GoalStuck("map", "unknown", "menu", 1, 1)
        assert link.snapshot().last_outcome_detail == "unknown: menu"
        assert core.revoked == [1, 2]
        model.called.clear()
        model.gate = asyncio.Event()
        assert await link.set_goal(GOAL) == ACK
        await model.called.wait()
        assert link.snapshot().active_goal_description == GOAL.description
    assert model.cancelled and core.revoked == [1, 2, 3]


@pytest.mark.parametrize("goal_id", [None, GOAL.goal_id])
async def test_cancel_during_inference(goal_id: str | None) -> None:
    model = Model((DONE,))
    model.gate = asyncio.Event()
    async with running(model) as (link, core, events):
        assert await link.cancel_goal() == ev.CommandAck(False, "idle")
        assert await link.set_goal(GOAL) == ACK
        await model.called.wait()
        assert await link.set_goal(GOAL) == ev.CommandAck(False, "busy")
        assert await link.cancel_goal("other") == ev.CommandAck(False, "goal_mismatch")
        assert await link.cancel_goal(goal_id, reason="changed") == ACK
        assert await events.get() == ev.GoalStuck("map", "cancelled", "changed", 1, 1)
        assert model.cancelled and core.revoked == [1]


async def test_pause_preserves_active_time_and_history() -> None:
    model = Model((WAIT, DONE))
    async with running(model) as (link, core, events):
        goal = replace(GOAL, max_steps=2, timeout_s=1)
        assert await link.set_goal(goal) == ACK
        await model.called.wait()
        model.called.clear()
        model.gate = asyncio.Event()
        await model.called.wait()
        assert await link.pause_pacing() == ACK
        await core.release.wait()
        assert model.cancelled and link.snapshot().paused
        await asyncio.sleep(goal.timeout_s)
        assert events.empty() and set(core.beats) == {1} and core.revoked == [1]
        model.gate.set()
        assert await link.resume_pacing() == ACK
        result = await events.get()
        assert isinstance(result, ev.GoalCompleted) and result.steps_taken == 2
        assert not link.snapshot().paused and core.revoked == [1, 2]
        assert set(core.beats) == {1, 2}
        first, interrupted, resumed = map(json.loads, model.prompts)
        assert first["step"] == 1 and resumed == interrupted
        assert resumed["step"] == 2 and resumed["history"][0]["action"] == "wait"


@pytest.mark.parametrize(("generation", "verification"), [
    (1, rpc.ReleaseVerification.VERIFIED),
    (2, rpc.ReleaseVerification.VERIFIED),
    (None, rpc.ReleaseVerification.VERIFIED),
    (1, rpc.ReleaseVerification.UP_FAILED),
    (1, rpc.ReleaseVerification.RESIDUAL),
    (1, rpc.ReleaseVerification.UNAVAILABLE),
])  # fmt: skip
async def test_revocation_after_resume(
    generation: int | None,
    verification: rpc.ReleaseVerification,
) -> None:
    model = Model((DONE,))
    model.gate = asyncio.Event()
    async with running(model) as (link, core, events):
        assert await link.set_goal(GOAL) == ACK
        await model.called.wait()
        assert await link.pause_pacing() == ACK
        await core.release.wait()
        model.called.clear()
        assert await link.resume_pacing() == ACK
        await model.called.wait()
        assert core.beats[-1] == 2

        producer = None if generation is None else rpc.Producer(ev.GAME_AGENT_ROLE, generation)
        reason = rpc.ReleaseReason.GENERATION_REVOKED
        core.session.on_released(
            replace(RELEASE, producer=producer, reason=reason, verification=verification)
        )
        if generation == 1 and verification == rpc.ReleaseVerification.VERIFIED:
            model.gate.set()
            assert isinstance(await events.get(), ev.GoalCompleted)
        else:
            assert await events.get() == ev.ControlReleased(GOAL.goal_id, reason, verification, 1)
        assert core.revoked == [1, 2]


async def test_session_accepts_next_goal_after_loop_error(monkeypatch: pytest.MonkeyPatch) -> None:
    model = Model((DONE,))
    async with running(model) as (link, core, events):
        with monkeypatch.context() as patch:
            patch.setattr(model, "complete_json", AsyncMock(side_effect=RuntimeError("private")))
            assert await link.set_goal(GOAL) == ACK
            assert await events.get() == ev.GoalStuck(
                GOAL.goal_id, "loop_error", "RuntimeError", 0, None
            )
        assert await link.set_goal(GOAL) == ACK
        assert isinstance(await events.get(), ev.GoalCompleted)
        assert core.revoked == [1, 2]


@pytest.mark.parametrize("release", [
    RELEASE, replace(RELEASE, reason=rpc.ReleaseReason.GENERATION_REVOKED,
                     verification=rpc.ReleaseVerification.RESIDUAL), None,
])  # fmt: skip
async def test_interrupt_sticky_pause(release: rpc.InputReleasedParams | None) -> None:
    model = Model((DONE,))
    async with running(model) as (link, core, events):
        assert await link.pause_pacing() == ACK
        assert await link.set_goal(GOAL) == ACK
        await core.release.wait()
        if release is None:
            assert await link.cancel_goal() == ACK
            assert await events.get() == ev.GoalStuck("map", "cancelled", "cancelled", 0, None)
        else:
            core.session.on_released(release)
            assert await events.get() == ev.ControlReleased(
                "map", release.reason, release.verification, 0
            )
        assert link.snapshot().active_goal_id is None and not model.called.is_set()
        assert not core.beats


def test_serve_cli(monkeypatch: pytest.MonkeyPatch) -> None:
    parser = cli.build_serve_parser()
    args = parser.parse_args([])
    assert (args.link_cred, args.permit_cred) == (
        ev.DEFAULT_GAME_LINK_TARGET,
        DEFAULT_SESSION_TARGET,
    )
    assert (args.profile, args.emergency_hotkey) == (Path("games/hsr.toml"), "ctrl+shift+f12")

    runner = AsyncMock(return_value=0)
    monkeypatch.setattr(cli, "_serve", runner)
    arguments = ["serve", "--link-cred", "link", "--permit-cred", "permit"]
    arguments.extend(["--profile", "custom.toml", "--emergency-hotkey", "ctrl+f12"])
    assert cli.main(arguments) == 0
    args = runner.call_args.args[0]
    assert (args.link_cred, args.permit_cred) == ("link", "permit")
    assert (args.profile, args.emergency_hotkey) == (Path("custom.toml"), "ctrl+f12")
