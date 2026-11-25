"""Host side of the authenticated external watchdog channel."""

import asyncio
import logging
import math
import secrets
from contextlib import suppress
from pathlib import Path
from typing import Any

from bellis_common.channel import (
    ChannelCredentials,
    ChannelError,
    ChannelServer,
    Connection,
    RpcPeer,
    create_channel_path,
    create_session_key,
    listen,
)

from .safety import SafetyCore

WATCHDOG_ROLE = "watchdog"
ENV_CHANNEL_PATH = "BELLIS_CHANNEL_PATH"
ENV_CHANNEL_KEY = "BELLIS_CHANNEL_KEY"
ENV_ROLE = "BELLIS_ROLE"
ENV_OBS_PASSWORD = "BELLIS_OBS_PASSWORD"


def find_watchdog_executable(repo_root: Path | None = None) -> Path:
    root = repo_root or Path(__file__).resolve().parents[4]
    for build in ("release", "debug"):
        exe = root / "core" / "target" / build / "bellis-watchdog.exe"
        if exe.is_file():
            return exe
    raise FileNotFoundError("bellis-watchdog.exe missing from core/target/{release,debug}")


class WatchdogLink:
    def __init__(
        self,
        safety: SafetyCore,
        *,
        heartbeat_interval_s: float = 0.25,
        session_id: str | None = None,
    ) -> None:
        if not 0 < heartbeat_interval_s < math.inf:
            raise ValueError("expected finite positive heartbeat interval")
        self.credentials = ChannelCredentials(
            create_channel_path(session_id or secrets.token_hex(6)), create_session_key()
        )
        self._safety = safety
        self._interval = heartbeat_interval_s
        self._server: ChannelServer | None = None
        self._peer: RpcPeer | None = None
        self._task: asyncio.Task[None] | None = None
        self._ready = asyncio.Event()
        self._stopping = asyncio.Event()
        self._lifecycle = asyncio.Lock()
        self._closing = False

    async def start(self) -> None:
        async with self._lifecycle:
            if self._server is None:
                self._closing = False
                self._server = await listen(
                    self.credentials.path,
                    self.credentials.key,
                    on_connection=self._accept,
                    on_rejected=lambda e: logging.warning("Watchdog channel rejected: %s", e.code),
                    on_error=lambda e: logging.error("Watchdog channel error: %s", e),
                )

    @property
    def connected(self) -> bool:
        return self._peer is not None and self._peer.connection.is_open

    async def wait_connected(self, timeout: float) -> None:
        await asyncio.wait_for(self._ready.wait(), timeout)

    def _acted(self, data: dict[str, Any]) -> None:
        reason = data.get("reason")
        if reason in ("heartbeat_lost", "connection_lost"):
            self._safety.record_watchdog_acted(reason)

    def _accept(self, conn: Connection) -> None:
        if self._closing or conn.role != WATCHDOG_ROLE or self.connected:
            conn.abort()
            return
        peer = RpcPeer(conn, timeout=self._interval)
        peer.on_notification("watchdog.acted", self._acted)
        self._stopping.clear()
        peer.on_notification("watchdog.stopping", lambda _: self._stopping.set())
        self._peer = peer
        self._task = asyncio.create_task(self._heartbeat(peer))
        self._ready.set()

    async def _heartbeat(self, peer: RpcPeer) -> None:
        try:
            while not self._closing and not peer.closed.done():
                peer.notify("host.heartbeat")
                await asyncio.wait({peer.closed}, timeout=self._interval)
        except (ChannelError, OSError):
            peer.connection.abort()
        finally:
            if self._peer is peer:
                self._ready.clear()
                self._peer = None

    async def close(self, planned: bool = True) -> None:
        async with self._lifecycle:
            self._closing = True
            peer = self._peer
            try:
                if peer is not None and planned:
                    # A queued pipe write can outlive the write call. Wait for the
                    # reader to confirm that its deadline has actually been disarmed.
                    with suppress(ChannelError, OSError, TimeoutError):
                        peer.notify("host.stopping")
                        await asyncio.wait_for(self._stopping.wait(), 2.0)
            finally:
                if peer is not None:
                    await peer.close()
                if self._server is not None:
                    await self._server.close()
                    self._server = None
                if self._task is not None:
                    await self._task
                    self._task = None
