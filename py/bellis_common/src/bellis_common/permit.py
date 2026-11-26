"""Unified realtime-core permit protocol and session server."""

from __future__ import annotations

import asyncio
import contextlib
import os
import secrets
import time
from collections.abc import Callable
from typing import Any, Final

from bellis_common import channel as ch
from bellis_common.cred import (
    DEFAULT_SESSION_TARGET,
    CredError,
    SessionInfo,
    delete_session_info,
    read_session_info,
    write_session_info,
)

from .permit_messages import (
    CaptureState,
    Empty,
    HealthParams,
    HeldAxis,
    HeldInput,
    HeldKey,
    HeldMouseButton,
    InputReleasedParams,
    InputStopParams,
    InputStopResult,
    LatestAudio,
    LatestFrame,
    LeaseRenewParams,
    LeaseRevokeParams,
    LeaseStatus,
    MouseButton,
    PermitMethods,
    Producer,
    ReleaseReason,
    ReleaseVerification,
)
from .wire_codec import ProtocolError

PERMIT_ROLE: Final = "realtime-core.permit"
FATAL_VERIFICATIONS = frozenset(
    (ReleaseVerification.UP_FAILED, ReleaseVerification.RESIDUAL, ReleaseVerification.UNAVAILABLE)
)
DEFAULT_LEASE_TTL_S: Final = 2.0
DEFAULT_RENEW_INTERVAL_S: Final = 0.5
DEFAULT_RPC_TIMEOUT_S: Final = 2.0
REVOKING_REASONS: Final = frozenset((
    ReleaseReason.TAKEOVER, ReleaseReason.EMERGENCY_STOP, ReleaseReason.HOOK_LOST,
    ReleaseReason.INJECTION_BLOCKED, ReleaseReason.LEASE_REVOKED,
    ReleaseReason.LEASE_EXPIRED, ReleaseReason.INPUT_STOP,
    ReleaseReason.LEASE_SOURCE_LOST, ReleaseReason.SHUTDOWN,
    ReleaseReason.STDIN_CLOSED, ReleaseReason.CORE_CONNECTION_LOST,
))  # fmt: skip


def _noop(_value: object) -> None:
    return None


def _fmt_release(rel: InputReleasedParams) -> str:
    res = f" residual={len(rel.residual_items)}" if rel.residual_items else ""
    return (
        f"id={rel.release_id} token={rel.token} reason={rel.reason.value} "
        f"ver={rel.verification.value}{res}"
    )


def _fmt_health(h: HealthParams) -> str:
    frame = "none" if h.latest_frame is None else f"#{h.latest_frame.frame_number}"
    return (
        f"cap={h.capture.value} aud={h.audio.value} lease={h.lease.value} "
        f"held={h.inputs_held} q={h.queue_depth} f={frame}"
    )


class PermitServer:
    """Unified 5-method permit RPC server with monotonic tokens and CredMan handoff."""

    def __init__(
        self,
        *,
        session_id: str | None = None,
        expected_role: str = PERMIT_ROLE,
        cred_target: str | None = DEFAULT_SESSION_TARGET,
        lease_ttl_s: float = DEFAULT_LEASE_TTL_S,
        renew_interval_s: float = DEFAULT_RENEW_INTERVAL_S,
        rpc_timeout_s: float = DEFAULT_RPC_TIMEOUT_S,
        on_released: Callable[[InputReleasedParams], None] | None = None,
        on_health: Callable[[HealthParams], None] | None = None,
        on_connection: Callable[[bool], None] | None = None,
        on_event: Callable[[str], None] | None = None,
    ) -> None:
        if not (0 < renew_interval_s < lease_ttl_s and rpc_timeout_s > 0):
            raise ValueError("invalid lease_ttl_s / renew_interval_s / rpc_timeout_s")
        self.session_id = session_id or f"pm{secrets.token_hex(4)}"
        self.expected_role = expected_role
        self.cred_target = cred_target
        self._ttl_ns = int(lease_ttl_s * 1_000_000_000)
        self._renew_s = renew_interval_s
        self._rpc_timeout_s = rpc_timeout_s
        self._emit = on_event or _noop
        self.credentials = ch.ChannelCredentials(
            ch.create_channel_path(self.session_id), ch.create_session_key()
        )
        self.session_info: SessionInfo | None = None
        self.last_health: HealthParams | None = None
        self.last_released: InputReleasedParams | None = None
        self.active_token: int | None = None
        self._token = 0
        self._server: ch.ChannelServer | None = None
        self._peer: ch.RpcPeer | None = None
        self._renew_task: asyncio.Task[None] | None = None
        self._released_event = asyncio.Event()
        self._finalized: dict[int, InputReleasedParams] = {}
        self._pending_grant: int | None = None
        self._released_callback = on_released or _noop
        self._health_callback = on_health or _noop
        self._connection_callback = on_connection or _noop
        self._connected_event = asyncio.Event()
        self._closed = False

    @property
    def connected(self) -> bool:
        return self._peer is not None and self._peer.connection.is_open

    async def start(self) -> SessionInfo:
        if self._server is not None or self._closed:
            raise RuntimeError("PermitServer already started")
        info = SessionInfo.create(self.credentials, self.session_id, launcher_pid=os.getpid())
        self._server = await ch.listen(
            self.credentials.path,
            self.credentials.key,
            on_connection=self._on_connection,
            on_rejected=lambda e: self._emit(f"[permit] rejected: {e}"),
            on_error=lambda e: self._emit(f"[permit] error: {e}"),
        )
        if self.cred_target is not None:
            try:
                write_session_info(info, self.cred_target)
            except BaseException:
                await self._server.close()
                self._server = None
                raise
        self.session_info = info
        return info

    async def wait_connected(self, timeout: float | None = None) -> None:
        async with asyncio.timeout(timeout):
            await self._connected_event.wait()

    async def grant_start(self) -> int:
        return await self.grant_token(self._token + 1)

    async def grant_token(
        self,
        token: int,
        *,
        lease_ttl_s: float | None = None,
        on_renew: Callable[[int], float | None] | None = None,
    ) -> int:
        if self._closed:
            raise ch.ChannelError("closed", "permit server is closed")
        if type(token) is not int or token <= (self._pending_grant or self._token):
            raise ValueError("permit token must be a strictly increasing positive integer")
        peer = self._require_peer()
        ttl_ns = self._ttl_ns if lease_ttl_s is None else int(lease_ttl_s * 1_000_000_000)
        if ttl_ns <= 0:
            raise ValueError("permit TTL must be positive")
        params = LeaseRenewParams(token, time.perf_counter_ns() + ttl_ns)
        self.cancel_renewal()
        self._pending_grant = token
        try:
            await self._send_renew(peer, params)
        except ch.RpcError:
            if self._pending_grant == token:
                self._pending_grant = None
            raise
        except BaseException:
            if self._pending_grant == token:
                self._token = max(self._token, token)
                self._pending_grant = None
            raise
        if self._pending_grant != token or self._peer is not peer:
            raise ch.ChannelError("closed", "permit grant interrupted")
        self._pending_grant = None
        self.active_token = self._token = token
        self._renew_task = asyncio.create_task(self._renew_loop(peer, token, ttl_ns, on_renew))
        return token

    async def pause(self) -> int | None:
        self.cancel_renewal()
        token = self._token
        if token <= 0 or not self.connected:
            return None
        raw = await self._require_peer().request(
            PermitMethods.LEASE_REVOKE, LeaseRevokeParams(token).to_dict()
        )
        Empty.from_dict(raw)
        return token

    async def stop_input(self, through_token: int | None = None) -> InputStopResult:
        if through_token is None or (self._pending_grant or self._token) <= through_token:
            self.cancel_renewal()
        raw = await self._require_peer().request(
            PermitMethods.INPUT_STOP, InputStopParams(through_token).to_dict()
        )
        return InputStopResult.from_dict(raw)

    async def stop_and_wait(
        self, through_token: int | None = None, *, timeout_s: float = 1.0
    ) -> InputReleasedParams | None:
        peer, finalized = self._require_peer(), self._finalized
        release_id = (await self.stop_input(through_token)).release_id
        if release_id is None:
            return None
        with contextlib.suppress(TimeoutError):
            async with asyncio.timeout(timeout_s):
                while release_id not in finalized and self._peer is peer and self.connected:
                    await self._released_event.wait()
        return finalized.get(release_id)

    def status_summary(self) -> str:
        conn = "connected" if self.connected else "waiting"
        health = "none" if self.last_health is None else _fmt_health(self.last_health)
        rel = "none" if self.last_released is None else _fmt_release(self.last_released)
        return (
            f"conn={conn} active_token={self.active_token} last_token={self._token}\n"
            f"  health:   {health}\n"
            f"  released: {rel}"
        )

    async def close(self, *, release_wait_s: float = 0.5) -> None:
        if self._closed:
            return
        self._closed = True
        should_stop = self.active_token is not None or self._pending_grant is not None
        self.cancel_renewal()
        try:
            if self.connected and should_stop:
                with contextlib.suppress(ch.ChannelError, ch.RpcError, ProtocolError):
                    await self.stop_and_wait(timeout_s=release_wait_s)
        finally:
            server, self._server = self._server, None
            if (peer := self._peer) is not None:
                self._on_peer_closed(peer)
                with contextlib.suppress(Exception):
                    await peer.close()
            if server is not None:
                with contextlib.suppress(Exception):
                    await server.close()
            if self.session_info is not None and self.cred_target is not None:
                with contextlib.suppress(CredError):
                    if read_session_info(self.cred_target) == self.session_info:
                        delete_session_info(self.cred_target)

    def _require_peer(self) -> ch.RpcPeer:
        if self._peer is None or not self._peer.connection.is_open:
            raise ch.ChannelError("closed", "realtime-core is not connected")
        return self._peer

    def cancel_renewal(self) -> None:
        """Withdraw local authority immediately, including an unacknowledged grant."""
        self.active_token = None
        # A lost acknowledgement can still represent a real remote grant. Fence it on revoke.
        self._token = self._pending_grant or self._token
        self._pending_grant = None
        if self._renew_task is not None:
            self._renew_task.cancel()
            self._renew_task = None

    def _on_connection(self, conn: ch.Connection) -> None:
        if self._closed or conn.role != self.expected_role or self.connected:
            conn.abort()
            return
        if self._peer is not None:
            self._on_peer_closed(self._peer)
        peer = ch.RpcPeer(conn, timeout=self._rpc_timeout_s)
        peer.on_notification(PermitMethods.INPUT_RELEASED, self._on_released)
        peer.on_notification(PermitMethods.HEALTH, self._on_health)
        peer.closed.add_done_callback(lambda _t: self._on_peer_closed(peer))
        self._finalized = {}
        self._released_event = asyncio.Event()
        self._peer = peer
        self._connected_event.set()
        self._connection_callback(True)
        self._emit(f"[permit] realtime-core connected (role={conn.role})")

    def _on_peer_closed(self, peer: ch.RpcPeer) -> None:
        if self._peer is peer:
            self.cancel_renewal()
            self._peer = None
            self._connected_event.clear()
            self._released_event.set()
            self._connection_callback(False)
            self._emit("[permit] realtime-core disconnected; lease cleared")

    def _on_released(self, raw: dict[str, Any]) -> None:
        try:
            rel = InputReleasedParams.from_dict(raw)
        except ProtocolError as exc:
            self._emit(f"[permit] invalid input.released: {exc}")
            return
        self.last_released = rel
        if rel.verification is not ReleaseVerification.UNVERIFIED:
            self._finalized[rel.release_id] = rel
            if len(self._finalized) > 128:
                del self._finalized[next(iter(self._finalized))]
            self._released_event.set()
            self._released_event.clear()
        issued = self._pending_grant or self._token
        if rel.reason in REVOKING_REASONS and (rel.token is None or rel.token >= issued):
            self.cancel_renewal()
        self._released_callback(rel)
        self._emit(f"[released] {_fmt_release(rel)}")

    def _on_health(self, raw: dict[str, Any]) -> None:
        with contextlib.suppress(ProtocolError):
            self.last_health = HealthParams.from_dict(raw)
            self._health_callback(self.last_health)

    @staticmethod
    async def _send_renew(peer: ch.RpcPeer, params: LeaseRenewParams) -> None:
        Empty.from_dict(await peer.request(PermitMethods.LEASE_RENEW, params.to_dict()))

    async def _renew_loop(
        self,
        peer: ch.RpcPeer,
        token: int,
        ttl_ns: int,
        on_renew: Callable[[int], float | None] | None,
    ) -> None:
        try:
            while self.active_token == token and peer.connection.is_open:
                await asyncio.sleep(self._renew_s)
                if self.active_token != token or not peer.connection.is_open:
                    return
                if on_renew is not None:
                    ttl = on_renew(token)
                    if ttl is None or ttl <= 0:
                        self.active_token = None
                        return
                    ttl_ns = int(ttl * 1_000_000_000)
                params = LeaseRenewParams(token, time.perf_counter_ns() + ttl_ns)
                await self._send_renew(peer, params)
        except asyncio.CancelledError:
            return
        except (ch.ChannelError, ch.RpcError, ProtocolError) as exc:
            if self.active_token == token:
                self.active_token = None
            self._emit(f"[permit] renewal stopped (token={token}): {exc}")


__all__ = [
    "CaptureState", "DEFAULT_LEASE_TTL_S", "DEFAULT_RENEW_INTERVAL_S", "DEFAULT_RPC_TIMEOUT_S",
    "Empty", "FATAL_VERIFICATIONS", "HealthParams", "HeldAxis", "HeldInput", "HeldKey",
    "HeldMouseButton", "InputReleasedParams", "InputStopParams", "InputStopResult",
    "LatestAudio", "LatestFrame", "LeaseRenewParams", "LeaseRevokeParams", "LeaseStatus",
    "MouseButton", "PERMIT_ROLE", "PermitMethods", "PermitServer", "Producer",
    "REVOKING_REASONS", "ReleaseReason", "ReleaseVerification",
]  # fmt: skip
