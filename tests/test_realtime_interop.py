"""Real-process Python <-> Rust ``realtime-core.exe`` and PermitServer interop tests.

All tests run without requiring an interactive Windows desktop or global input hooks,
so they remain 100% deterministic even under locked screens or headless terminals.
"""

from __future__ import annotations

import asyncio
import secrets
import subprocess
from pathlib import Path
from typing import Any

import pytest
from bellis_common.channel import (
    ChannelError,
    RpcError,
    RpcPeer,
    connect,
    create_channel_path,
    create_session_key,
    encode_session_key,
    listen,
)
from bellis_game.console import PermitServer
from bellis_game.io import (
    CORE_ROLE,
    ENV_CHANNEL_KEY,
    ENV_CHANNEL_PATH,
    ENV_ROLE,
    PERMIT_ROLE,
    AudioRing,
    CoreClient,
    CoreClientOptions,
    FrameRing,
    ManagedProcess,
    StopStage,
    base_environment,
)
from bellis_game.io.protocol import (
    CaptureState,
    CoreErrorCode,
    Empty,
    HealthParams,
    InputPolicy,
    InputReleasedParams,
    InputStopParams,
    InputStopResult,
    LeaseRenewParams,
    LeaseRevokeParams,
    LeaseStatus,
    MouseButton,
    NormRect,
    PermitMethods,
    Producer,
    ReleaseReason,
    ReleaseVerification,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
CORE_DIR = REPO_ROOT / "core"
DEBUG_CORE_EXE = CORE_DIR / "target" / "debug" / "realtime-core.exe"


@pytest.fixture(scope="session")
def realtime_core_exe() -> Path:
    if not DEBUG_CORE_EXE.is_file():
        proc = subprocess.run(
            ["cargo", "build", "-p", "realtime-core"],
            cwd=CORE_DIR,
            check=False,
            capture_output=True,
            text=True,
        )
        assert proc.returncode == 0, f"cargo build failed:\n{proc.stderr}"
    assert DEBUG_CORE_EXE.is_file()
    return DEBUG_CORE_EXE


async def test_rust_core_rejects_wrong_channel_key(realtime_core_exe: Path) -> None:
    path = create_channel_path(f"bad{secrets.token_hex(4)}")
    server_key = create_session_key()
    wrong_key = create_session_key()
    rejected: asyncio.Future[ChannelError] = asyncio.get_running_loop().create_future()

    def on_rejected(err: ChannelError) -> None:
        if not rejected.done():
            rejected.set_result(err)

    server = await listen(
        path,
        server_key,
        on_connection=lambda conn: conn.abort(),
        on_rejected=on_rejected,
        on_error=lambda _err: None,
    )
    try:
        env = {
            **base_environment(),
            ENV_CHANNEL_PATH: path,
            ENV_CHANNEL_KEY: encode_session_key(wrong_key),
            ENV_ROLE: CORE_ROLE,
        }
        proc = ManagedProcess.start(
            "realtime-core-bad-key",
            [str(realtime_core_exe)],
            env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        try:
            err = await asyncio.wait_for(rejected, timeout=5.0)
            # Mutual auth: Rust client rejects the mismatched server challenge proof and closes.
            assert err.code in {"closed", "auth-failed"}
            returncode = await asyncio.wait_for(proc.exited, timeout=5.0)
            assert returncode != 0
            stderr_pipe = proc._popen.stderr  # pyright: ignore[reportPrivateUsage]
            assert stderr_pipe is not None
            err_text = stderr_pipe.read().decode("utf-8", errors="replace")
            assert "auth" in err_text.lower() or "key" in err_text.lower()
        finally:
            await proc.stop()
    finally:
        await server.close()


async def test_core_client_hello_health_rings_policy_and_graceful_shutdown(
    realtime_core_exe: Path,
) -> None:
    health_seen = asyncio.Event()
    releases: list[InputReleasedParams] = []
    revoked_seen = asyncio.Event()

    def on_released(rel: InputReleasedParams) -> None:
        releases.append(rel)
        if rel.reason is ReleaseReason.GENERATION_REVOKED:
            revoked_seen.set()

    def on_health(_h: HealthParams) -> None:
        health_seen.set()

    options = CoreClientOptions(
        executable=realtime_core_exe,
        health_interval=0.05,
        heartbeat_timeout=0.5,
        max_frame_age=0.5,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    client = CoreClient(options, on_released=on_released, on_health=on_health)
    await client.start()
    try:
        assert client.running
        assert client.core_version is not None
        assert client.hello_at_ns is not None
        assert any(r.reason is ReleaseReason.CORE_START for r in releases)

        await asyncio.wait_for(health_seen.wait(), timeout=3.0)
        assert client.last_health is not None
        assert client.last_health.lease is LeaseStatus.NOT_GRANTED

        # Real shared-memory FrameRing and AudioRing mount verified by Rust realtime-core.
        with (
            FrameRing.create(64, 64, slot_count=3) as frames,
            AudioRing.create(48_000, 2, block_capacity=480, block_count=4) as audio,
        ):
            await client.attach_frame_ring(frames)
            await client.attach_audio_ring(audio)

            # Configure input policy once; second attempt must conflict (-32006).
            policy = InputPolicy(
                click_buttons=(MouseButton.LEFT,),
                press_keys=(57,),
                scroll=False,
                click_regions=(NormRect(0.0, 0.0, 1.0, 1.0),),
                forbidden_zones=(),
                press_duration_ms=40,
                max_rate=10.0,
                hold_keys=(),
                hold_buttons=(),
                max_hold_ms=None,
            )
            await client.configure_input(policy)
            with pytest.raises(RpcError) as conflict:
                await client.configure_input(policy)
            assert conflict.value.code == CoreErrorCode.INPUT_POLICY_CONFLICT

            # Producer heartbeat + generation revoke.
            client.send_heartbeat(Producer(id="test-fast", generation=1), seq=1)
            revoke_res = await client.revoke_producer(1)
            assert revoke_res.release_id is not None
            await asyncio.wait_for(revoked_seen.wait(), timeout=2.0)

        stop_res = await client.stop()
        assert stop_res.stage is StopStage.SHUTDOWN
        assert stop_res.returncode == 0
    finally:
        await client.stop()


async def test_core_client_exits_cleanly_on_stdin_eof(realtime_core_exe: Path) -> None:
    stdin_released = asyncio.Event()

    def on_released(rel: InputReleasedParams) -> None:
        if rel.reason is ReleaseReason.STDIN_CLOSED:
            stdin_released.set()

    options = CoreClientOptions(
        executable=realtime_core_exe,
        health_interval=5.0,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    client = CoreClient(options, on_released=on_released)
    await client.start()
    try:
        proc = client.process
        assert proc is not None
        proc.close_stdin()
        await asyncio.wait_for(stdin_released.wait(), timeout=3.0)
        returncode = await asyncio.wait_for(proc.exited, timeout=3.0)
        assert returncode == 0
    finally:
        await client.stop()


async def test_permit_server_unified_5_method_rpc_state_machine() -> None:
    events: list[str] = []
    server = PermitServer(
        cred_target=None,
        lease_ttl_s=0.6,
        renew_interval_s=0.08,
        on_event=events.append,
    )
    await server.start()
    try:
        conn = await connect(
            server.credentials.path, PERMIT_ROLE, server.credentials.key, handshake_timeout=2.0
        )
        peer = RpcPeer(conn, timeout=2.0)
        renew_calls: list[LeaseRenewParams] = []
        revoke_calls: list[LeaseRevokeParams] = []
        stop_calls: list[InputStopParams] = []
        next_release_id = 0

        def handle_renew(raw: dict[str, Any]) -> dict[str, object]:
            renew_calls.append(LeaseRenewParams.from_dict(raw))
            return Empty().to_dict()

        def handle_revoke(raw: dict[str, Any]) -> dict[str, object]:
            nonlocal next_release_id
            params = LeaseRevokeParams.from_dict(raw)
            revoke_calls.append(params)
            next_release_id += 1
            peer.notify(
                PermitMethods.INPUT_RELEASED,
                InputReleasedParams(
                    release_id=next_release_id,
                    token=params.token,
                    reason=ReleaseReason.LEASE_REVOKED,
                    producer=None,
                    released_at_ns=1_000,
                    verification=ReleaseVerification.VERIFIED,
                    residual_items=(),
                ).to_dict(),
            )
            return Empty().to_dict()

        def handle_stop(raw: dict[str, Any]) -> dict[str, object]:
            nonlocal next_release_id
            params = InputStopParams.from_dict(raw)
            stop_calls.append(params)
            next_release_id += 1
            peer.notify(
                PermitMethods.INPUT_RELEASED,
                InputReleasedParams(
                    release_id=next_release_id,
                    token=None,
                    reason=ReleaseReason.INPUT_STOP,
                    producer=None,
                    released_at_ns=2_000,
                    verification=ReleaseVerification.VERIFIED,
                    residual_items=(),
                ).to_dict(),
            )
            return InputStopResult(release_id=next_release_id).to_dict()

        peer.handle(PermitMethods.LEASE_RENEW, handle_renew)
        peer.handle(PermitMethods.LEASE_REVOKE, handle_revoke)
        peer.handle(PermitMethods.INPUT_STOP, handle_stop)

        await server.wait_connected(timeout=2.0)
        assert server.connected

        # 1. Start grants token 1 and triggers periodic renewals.
        tok1 = await server.grant_start()
        assert tok1 == 1 and server.active_token == 1
        await asyncio.sleep(0.22)
        assert len(renew_calls) >= 2
        assert all(call.token == 1 for call in renew_calls)
        assert renew_calls[-1].expires_ns > renew_calls[0].expires_ns

        # 2. Pause revokes token 1 and stops renewals.
        revoked = await server.pause()
        assert revoked == 1 and server.active_token is None
        assert revoke_calls == [LeaseRevokeParams(token=1)]
        count_after_pause = len(renew_calls)
        await asyncio.sleep(0.15)
        assert len(renew_calls) == count_after_pause

        # 3. Second start increments monotonically to token 2; takeover notification clears lease.
        tok2 = await server.grant_start()
        assert tok2 == 2 and server.active_token == 2
        peer.notify(
            PermitMethods.INPUT_RELEASED,
            InputReleasedParams(
                release_id=99,
                token=2,
                reason=ReleaseReason.TAKEOVER,
                producer=None,
                released_at_ns=3_000,
                verification=ReleaseVerification.VERIFIED,
                residual_items=(),
            ).to_dict(),
        )
        await asyncio.sleep(0.05)
        assert server.active_token is None
        assert server.last_released is not None
        assert server.last_released.reason is ReleaseReason.TAKEOVER

        # 4. Third start -> unconditional input.stop -> health update -> disconnect cleanup.
        tok3 = await server.grant_start()
        assert tok3 == 3
        stop_result = await server.stop_input(through_token=None)
        assert stop_result.release_id == next_release_id
        assert stop_calls == [InputStopParams(through_token=None)]
        assert server.active_token is None

        peer.notify(
            PermitMethods.HEALTH,
            HealthParams(
                now_ns=4_000,
                capture=CaptureState.CAPTURING,
                audio=CaptureState.IDLE,
                inputs_held=False,
                producer=None,
                latest_frame=None,
                latest_audio=None,
                lease=LeaseStatus.REVOKED,
                queue_depth=0,
            ).to_dict(),
        )
        await asyncio.sleep(0.05)
        assert server.last_health is not None
        assert "capturing" in server.status_summary()

        await peer.close()
        await asyncio.sleep(0.05)
        assert not server.connected
        assert server.active_token is None
    finally:
        await server.close()
