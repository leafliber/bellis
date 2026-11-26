"""Direct operator control of the realtime-core input lease."""

import asyncio
import math
from collections.abc import Callable, Coroutine
from contextlib import suppress
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from bellis_common import permit
from bellis_common.channel import ChannelCredentials, ChannelError, RpcError
from bellis_common.cred import SessionInfo
from bellis_common.permit import HealthParams, InputReleasedParams, ReleaseReason
from bellis_common.wire_codec import ProtocolError

from .safety import EmergencySummary, HostMode, LeaseUpdate, SafetyCore, SafetyError

_RESOURCE = "game.input"
_RPC_ERRORS = (ChannelError, RpcError, ProtocolError)
_EMERGENCIES = {
    ReleaseReason.EMERGENCY_STOP,
    ReleaseReason.HOOK_LOST,
    ReleaseReason.INJECTION_BLOCKED,
}


@dataclass(frozen=True)
class GamePermitConfig:
    cred_target: str | None = None
    lease_ttl_s: float = permit.DEFAULT_LEASE_TTL_S
    renew_interval_s: float = permit.DEFAULT_RENEW_INTERVAL_S
    release_wait_s: float = 1.0
    session_id: str | None = None

    def __post_init__(self) -> None:
        for timeout in (self.lease_ttl_s, self.renew_interval_s, self.release_wait_s):
            if type(timeout) not in (int, float) or not 0 < timeout < math.inf:
                raise ValueError("permit timeouts must be finite positive numbers")
        if self.renew_interval_s >= self.lease_ttl_s:
            raise ValueError("permit renewal interval must be shorter than the lease")
        target = self.cred_target
        if target is not None and (type(target) is not str or not target or "\0" in target):
            raise ValueError("invalid permit credential target")


@dataclass(frozen=True)
class GamePermitSnapshot:
    connected: bool
    armed: bool
    active_token: int | None
    capture: str | None
    lease: str | None
    inputs_held: bool
    last_release_reason: str | None
    last_release_verification: str | None
    last_release_id: int | None


class HostGamePermit:
    def __init__(self, safety: SafetyCore, config: GamePermitConfig = GamePermitConfig()):
        self._safety, self._config = safety, config
        self._server = permit.PermitServer(
            cred_target=config.cred_target,
            lease_ttl_s=config.lease_ttl_s,
            renew_interval_s=config.renew_interval_s,
            session_id=config.session_id,
            on_connection=self._connection,
            on_health=self._health_update,
            on_released=self._released,
        )
        self._health: HealthParams | None = None
        self._lock = asyncio.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._unsubscribe: list[Callable[[], None]] = []
        self._local = ContextVar("permit_transition", default=False)
        self._tasks: set[asyncio.Task[object]] = set()
        self._stop: asyncio.Task[InputReleasedParams | None] | None = None
        self._emergency_release: int | None = None
        self._issued = 0
        self._closed = False

    @property
    def credentials(self) -> ChannelCredentials:
        return self._server.credentials

    @property
    def session_info(self) -> SessionInfo | None:
        return self._server.session_info

    @property
    def connected(self) -> bool:
        return self._server.connected

    @property
    def active_token(self) -> int | None:
        return self._server.active_token

    @property
    def armed(self) -> bool:
        token = self.active_token
        return (
            self.connected and token is not None and self._safety.is_lease_valid(_RESOURCE, token)
        )

    async def start(self) -> SessionInfo:
        if self._closed or self._loop:
            raise SafetyError("permit server cannot start")
        self._loop = asyncio.get_running_loop()
        self._unsubscribe = [
            self._safety.on_lease_update(self._lease_update),
            self._safety.on_emergency(self._emergency),
        ]
        try:
            return await self._server.start()
        except BaseException:
            await self.close()
            raise

    async def wait_connected(self, timeout: float | None = None) -> None:
        await self._server.wait_connected(timeout)

    async def arm_input(self, *, actor: str = "operator") -> int:
        if not isinstance(actor, str) or not actor.strip():  # pyright: ignore[reportUnnecessaryIsInstance]
            raise ValueError("actor must be non-empty")
        async with self._lock:
            if self._closed:
                raise SafetyError("permit server is closed")
            if not self.connected:
                raise ChannelError("closed", "realtime-core is not connected")
            if self._safety.snapshot().mode != HostMode.LIVE:
                raise SafetyError("arming game input requires LIVE")
            if self._stop and not self._stop.done():
                raise SafetyError("input stop is awaiting verification")
            if self.armed and self.active_token is not None:
                return self.active_token
            lease = self._safety.grant_lease(_RESOURCE, "host")
            self._issued = lease.token
            try:
                await self._server.grant_token(
                    lease.token, lease_ttl_s=lease.ttl_s, on_renew=self._on_renew
                )
                if not self.armed:
                    raise SafetyError("permit grant interrupted")
            except BaseException:
                self._revoke("permit_grant_failed")
                await self._pause(lease.token)
                raise
            return lease.token

    def _on_renew(self, token: int) -> float | None:
        try:
            return self._safety.renew_lease(_RESOURCE, "host", token).ttl_s
        except SafetyError:
            return None

    def _revoke(self, reason: str) -> None:
        mark = self._local.set(True)
        try:
            self._safety.revoke_lease(_RESOURCE, reason)
        finally:
            self._local.reset(mark)

    async def _pause(self, token: int) -> int | None:
        # A queued revocation belongs to the grant observed by its safety callback.
        if token == self._issued:
            with suppress(*_RPC_ERRORS):
                return await self._server.pause()
        return None

    async def disarm_input(self, *, reason: str = "operator_disarm") -> int | None:
        async with self._lock:
            self._revoke(reason)
            return await self._pause(self._issued)

    async def emergency_stop(self, *, timeout_s: float | None = None) -> InputReleasedParams | None:
        self._server.cancel_renewal()
        if any(lease.resource == _RESOURCE for lease in self._safety.snapshot().active_leases):
            self._revoke("game_permit:emergency_stop")
        if not self.connected:
            return None
        if self._stop is None or self._stop.done():
            timeout = self._config.release_wait_s if timeout_s is None else timeout_s
            self._stop = asyncio.create_task(self._server.stop_and_wait(timeout_s=timeout))
        with suppress(*_RPC_ERRORS):
            return await asyncio.shield(self._stop)
        return None

    def _schedule(self, action: Callable[[], Coroutine[Any, Any, object]]) -> None:
        def run() -> None:
            task = asyncio.create_task(action())
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

        if self._loop and not self._closed:
            self._loop.call_soon_threadsafe(run)

    def _lease_update(self, update: LeaseUpdate) -> None:
        if (
            update.resource == _RESOURCE
            and update.lease is None
            and not self._local.get()
            and self._safety.snapshot().mode != HostMode.EMERGENCY_STOP
        ):
            token = self._issued
            self._schedule(lambda: self._pause(token))

    def _emergency(self, _: EmergencySummary) -> None:
        if not self._local.get():
            self._schedule(self.emergency_stop)

    def _released(self, rel: InputReleasedParams) -> None:
        if self._closed or rel.reason == ReleaseReason.CORE_START:
            return
        reason = f"game_permit:{rel.reason.value}"
        if rel.reason in _EMERGENCIES or rel.verification in permit.FATAL_VERIFICATIONS:
            if (
                self._emergency_release == rel.release_id
                and self._safety.snapshot().mode == HostMode.EMERGENCY_STOP
            ):
                return
            self._emergency_release = rel.release_id
            self._server.cancel_renewal()
            mark = self._local.set(True)
            try:
                self._safety.trigger_emergency(reason, source="realtime-core")
            finally:
                self._local.reset(mark)
        elif (rel.token is None or rel.token >= self._issued) and (
            rel.reason in permit.REVOKING_REASONS or rel.reason == ReleaseReason.FOCUS_LOST
        ):
            self._revoke(reason)
            if rel.reason == ReleaseReason.FOCUS_LOST:
                self._server.cancel_renewal()
                token = self._issued
                self._schedule(lambda: self._pause(token))

    def _connection(self, connected: bool) -> None:
        self._health = self._emergency_release = None
        if not connected and not self._closed:
            self._revoke("game_permit:disconnected")

    def _health_update(self, health: HealthParams) -> None:
        self._health = health

    def snapshot(self) -> GamePermitSnapshot:
        health, rel = self._health, self._server.last_released
        return GamePermitSnapshot(
            self.connected,
            self.armed,
            self.active_token,
            health and health.capture.value,
            health and health.lease.value,
            bool(health and health.inputs_held),
            rel and rel.reason.value,
            rel and rel.verification.value,
            rel and rel.release_id,
        )

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            for unsubscribe in self._unsubscribe:
                unsubscribe()
            self._revoke("game_permit:closed")
            if self.active_token is not None:
                await self.emergency_stop()
            await asyncio.sleep(0)  # Admit callbacks already queued by the safety thread.
            await asyncio.gather(*self._tasks, return_exceptions=True)
            if self._stop:
                with suppress(*_RPC_ERRORS):
                    await self._stop
        finally:
            await self._server.close(release_wait_s=self._config.release_wait_s)
