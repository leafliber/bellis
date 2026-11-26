import asyncio
from collections.abc import AsyncGenerator, Callable
from contextlib import asynccontextmanager
from dataclasses import replace
from typing import cast
from unittest.mock import AsyncMock, Mock

import pytest
from bellis_common import channel, permit
from bellis_common.cred import SessionInfo
from bellis_common.permit import (
    InputReleasedParams,
    PermitMethods,
    ReleaseReason,
    ReleaseVerification,
)
from bellis_game import console
from bellis_game.io import protocol
from bellis_host import HostApp, HostGamePermit, HostMode, SafetyError
from bellis_host import app as launcher
from test_console_and_slow_agent import Browser
from test_host_app import running as running
from test_obs_and_watchdog import ObsServer, assert_batch
from test_obs_and_watchdog import obs as obs
from test_realtime_interop import released


async def until(predicate: Callable[[], bool]) -> None:
    async with asyncio.timeout(3):
        while not predicate():
            await asyncio.sleep(0)


@asynccontextmanager
async def pipe(server: permit.PermitServer | HostGamePermit) -> AsyncGenerator[channel.RpcPeer]:
    cred = server.credentials
    peer = channel.RpcPeer(
        await channel.connect(cred.path, permit.PERMIT_ROLE, cred.key), timeout=2
    )
    try:
        await server.wait_connected(2)
        yield peer
    finally:
        await peer.close()


def respond(peer: channel.RpcPeer, method: str, **result: object) -> Mock:
    handler = Mock(return_value=result)
    peer.handle(method, handler)
    return handler


async def test_shared_permit_and_final_verification() -> None:
    assert console.PermitServer is permit.PermitServer
    assert protocol.InputReleasedParams is InputReleasedParams
    releases: list[InputReleasedParams] = []
    server = permit.PermitServer(
        cred_target=None, renew_interval_s=0.01, on_released=releases.append
    )
    await server.start()
    try:
        async with pipe(server) as peer:
            renew = respond(peer, PermitMethods.LEASE_RENEW)
            stop = respond(peer, PermitMethods.INPUT_STOP, release_id=8)
            veto = Mock(return_value=None)
            assert await server.grant_token(12, on_renew=veto) == 12
            for invalid in (0, True, 11, 12):
                with pytest.raises(ValueError):
                    await server.grant_token(invalid)
            await until(lambda: server.active_token is None)
            veto.assert_called_once_with(12)
            assert renew.call_count == 1 and renew.call_args.args[0]["token"] == 12
            early = released(peer, ReleaseReason.INPUT_STOP)
            await until(lambda: early in releases)
            assert await server.stop_and_wait(12) == early
            stop.assert_called_once_with({"through_token": 12})
            stop.return_value = {"release_id": 9}
            wait = asyncio.create_task(server.stop_and_wait())
            await until(lambda: stop.call_count == 2)
            reason = ReleaseReason.INPUT_STOP
            preliminary = released(peer, reason, ReleaseVerification.UNVERIFIED, release_id=9)
            await until(lambda: preliminary in releases)
            assert not wait.done()
            final = released(peer, reason, release_id=9)
            assert await wait == final
            stop.return_value = {"release_id": 10}
            wait = asyncio.create_task(server.stop_and_wait(timeout_s=30))
            await until(lambda: stop.call_count == 3)
        assert await asyncio.wait_for(wait, 1) is None
    finally:
        await server.close()


async def test_grant_start_advances_after_timeout() -> None:
    server = permit.PermitServer(cred_target=None, rpc_timeout_s=0.25)
    tokens: list[int] = []

    async def renew(raw: dict[str, object]) -> object:
        token = permit.LeaseRenewParams.from_dict(raw).token
        tokens.append(token)
        if token == 1:
            await asyncio.Event().wait()  # The peer receives the grant but never acknowledges it.
        return {}

    await server.start()
    try:
        async with pipe(server) as peer:
            peer.handle(PermitMethods.LEASE_RENEW, renew)
            with pytest.raises(channel.ChannelError) as failure:
                await server.grant_start()
            assert failure.value.code == "timeout" and server.active_token is None
            assert await server.grant_start() == 2
            assert tokens == [1, 2]
    finally:
        await server.close()


async def test_cancelled_close_disconnects_permit_peer(running: tuple[HostApp, Browser]) -> None:
    app, _ = running
    game = app.game_permit
    app.safety.start_live()
    async with pipe(game) as peer:
        respond(peer, PermitMethods.LEASE_RENEW)
        stop = respond(peer, PermitMethods.INPUT_STOP, release_id=8)
        await game.arm_input()
        closing = asyncio.create_task(game.close())
        await until(lambda: stop.called)
        released(peer, ReleaseReason.INPUT_STOP, ReleaseVerification.UNVERIFIED, release_id=8)
        await until(lambda: game.snapshot().last_release_id == 8)
        closing.cancel()
        with pytest.raises(asyncio.CancelledError):
            await closing
        assert not game.connected


async def test_operator_routes_and_downward_sync(running: tuple[HostApp, Browser]) -> None:
    app, browser = running
    game = app.game_permit
    assert (await browser.api("/api/game/arm", {}))[0] == 503
    assert not (await browser.api("/api/status"))[1]["game_permit"]["connected"]
    async with pipe(game) as peer:
        renew = respond(peer, PermitMethods.LEASE_RENEW)
        revoke = respond(peer, PermitMethods.LEASE_REVOKE)
        stop = respond(peer, PermitMethods.INPUT_STOP, release_id=8)
        assert (await browser.api("/api/game/arm", {}))[0] == 409
        app.safety.start_live()
        for actor in (None, "", "  "):
            with pytest.raises(ValueError, match="actor must be non-empty"):
                await game.arm_input(actor=cast(str, actor))
        renew.assert_not_called()
        token = app.store.next_lease_token("game.input") + 1
        assert await browser.api("/api/game/arm", {}) == (200, {"ok": True, "token": token})
        assert await game.arm_input() == token
        original = app.safety.snapshot().active_leases[0]
        await until(lambda: renew.call_count >= 2)
        renewal = app.safety.snapshot().active_leases[0]
        assert (
            renewal.holder == "host"
            and renewal.token == token
            and renewal.expires_at > original.expires_at
        )
        capture, audio = permit.CaptureState.CAPTURING, permit.CaptureState.IDLE
        lease = permit.LeaseStatus.VALID
        health = permit.HealthParams(42, capture, audio, True, None, None, None, lease, 0)
        peer.notify(PermitMethods.HEALTH, health.to_dict())
        await until(lambda: game.snapshot().inputs_held)
        status = (await browser.api("/api/status"))[1]["game_permit"]
        assert status["armed"] and status["capture"] == "capturing" and status["lease"] == "valid"
        assert await browser.api("/api/game/disarm", {}) == (200, {"ok": True, "token": token})
        revoke.assert_called_once_with({"token": token})
        assert app.store.current_lease_token("game.input") == token + 1
        newer = await game.arm_input()
        await asyncio.to_thread(app.safety.pause_live)
        await until(lambda: revoke.call_count == 2)
        assert not game.armed and revoke.call_args.args == ({"token": newer},)
        app.safety.start_live()
        await game.arm_input()
        await asyncio.to_thread(app.safety.trigger_emergency, "manual")
        await until(lambda: stop.called)
        closing = asyncio.create_task(game.close())
        await asyncio.sleep(0)
        assert not closing.done()
        released(peer, ReleaseReason.INPUT_STOP)
        await closing
        stop.assert_called_once_with({"through_token": None})
        assert revoke.call_count == 2


async def test_failed_and_interrupted_grants(running: tuple[HostApp, Browser]) -> None:
    app, _ = running
    app.safety.start_live()
    game = app.game_permit
    async with pipe(game) as peer:
        with pytest.raises(channel.RpcError):
            await game.arm_input()  # Missing remote method rejects the grant.
        assert not app.safety.snapshot().active_leases and not game.armed
        entered, reply = asyncio.Event(), asyncio.Event()

        async def grant(_: object) -> object:
            entered.set()
            await reply.wait()
            return {}

        peer.handle(PermitMethods.LEASE_RENEW, grant)
        respond(peer, PermitMethods.LEASE_REVOKE)
        respond(peer, PermitMethods.INPUT_STOP, release_id=None)
        arm = asyncio.create_task(game.arm_input())
        await asyncio.wait_for(entered.wait(), 1)
        await asyncio.wait_for(game.emergency_stop(), 1)
        reply.set()
        with pytest.raises((channel.ChannelError, SafetyError)):
            await arm
        assert not app.safety.snapshot().active_leases and game.active_token is None
        reply.clear()
        entered.clear()
        arm = asyncio.create_task(game.arm_input())
        await asyncio.wait_for(entered.wait(), 1)
        arm.cancel()
        with pytest.raises(asyncio.CancelledError):
            await arm
        assert not app.safety.snapshot().active_leases and not game.armed


async def test_game_only_releases_and_disconnect(running: tuple[HostApp, Browser]) -> None:
    app, _ = running
    game = app.game_permit
    app.safety.start_live()
    other = app.safety.grant_lease("obs.control", "host")
    async with pipe(game) as peer:
        respond(peer, PermitMethods.LEASE_RENEW)
        revoke = respond(peer, PermitMethods.LEASE_REVOKE)
        token = await game.arm_input()
        released(peer, ReleaseReason.CORE_START, ReleaseVerification.UNAVAILABLE)
        await until(lambda: game.snapshot().last_release_reason == "core_start")
        assert game.armed
        for reason in (ReleaseReason.TAKEOVER, ReleaseReason.FOCUS_LOST):
            released(peer, reason, ReleaseVerification.VERIFIED, token)
            await until(
                lambda expected=reason.value: game.snapshot().last_release_reason == expected
            )
            assert game.active_token is None
            assert not app.safety.is_lease_valid("game.input", token)
            if reason == ReleaseReason.FOCUS_LOST:
                await until(lambda: revoke.called)
                revoke.assert_called_once_with({"token": token})
            token = await game.arm_input()
    await until(lambda: not app.safety.is_lease_valid("game.input", token))
    assert app.safety.snapshot().active_leases == (other,)
    assert app.safety.snapshot().mode == HostMode.LIVE


@pytest.mark.parametrize(
    ("reason", "verification"),
    [
        (ReleaseReason.EMERGENCY_STOP, ReleaseVerification.VERIFIED),
        (ReleaseReason.HOOK_LOST, ReleaseVerification.VERIFIED),
        (ReleaseReason.INJECTION_BLOCKED, ReleaseVerification.VERIFIED),
        (ReleaseReason.FRAME_STALE, ReleaseVerification.UP_FAILED),
        (ReleaseReason.FRAME_STALE, ReleaseVerification.RESIDUAL),
        (ReleaseReason.FRAME_STALE, ReleaseVerification.UNAVAILABLE),
    ],
)
async def test_core_emergency_reaches_obs(
    running: tuple[HostApp, Browser],
    obs: ObsServer,
    reason: ReleaseReason,
    verification: ReleaseVerification,
) -> None:
    app, _ = running
    app.safety.start_live()
    async with pipe(app.game_permit) as peer:
        stop = respond(peer, PermitMethods.INPUT_STOP, release_id=None)
        respond(peer, PermitMethods.LEASE_RENEW)
        token = await app.game_permit.arm_input()
        released(peer, reason, verification, token)
        await asyncio.wait_for(obs.batch_seen.wait(), 2)
        assert_batch(obs)
        assert app.safety.snapshot().mode == HostMode.EMERGENCY_STOP
        assert not app.game_permit.armed
        stop.assert_not_called()


async def test_console_stops_input_despite_obs_failure(
    running: tuple[HostApp, Browser], monkeypatch: pytest.MonkeyPatch
) -> None:
    app, browser = running
    assert app.obs
    monkeypatch.setattr(app.obs, "run_emergency", AsyncMock(side_effect=OSError("offline")))
    async with pipe(app.game_permit) as peer:
        stop = respond(peer, PermitMethods.INPUT_STOP, release_id=8)
        request = asyncio.create_task(browser.api("/api/control/emergency", {}))
        await until(lambda: stop.called)
        released(peer, ReleaseReason.INPUT_STOP)
        assert (await request)[0] == 502
        stop.assert_called_once_with({"through_token": None})


def test_host_credential_cleanup(monkeypatch: pytest.MonkeyPatch) -> None:
    server = permit.PermitServer(cred_target=None)
    info = SessionInfo.create(server.credentials, server.session_id, launcher_pid=42)
    sessions = [None, replace(info, launcher_pid=43), info]
    delete = Mock()
    monkeypatch.setattr(launcher, "read_session_info", Mock(side_effect=sessions))
    monkeypatch.setattr(launcher, "delete_session_info", delete)
    cleanup = launcher._cleanup_host_cred  # pyright: ignore[reportPrivateUsage]
    cleanup("target", 42)
    cleanup("target", 42)
    delete.assert_not_called()
    cleanup("target", 42)
    delete.assert_called_once_with("target")
