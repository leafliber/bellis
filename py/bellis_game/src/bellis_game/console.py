"""Standalone permit control console speaking the unified 5-method permit RPC."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import os
import secrets
import sys
import threading
import time
from collections.abc import Callable
from typing import Any, Final

from bellis_common import channel as ch
from bellis_common.cred import (
    DEFAULT_SESSION_TARGET,
    CredError,
    SessionInfo,
    delete_session_info,
    write_session_info,
)

from bellis_game.io import protocol as proto
from bellis_game.io.core_client import ENV_PERMIT_KEY, ENV_PERMIT_PATH, PERMIT_ROLE

DEFAULT_LEASE_TTL_S: Final = 2.0
DEFAULT_RENEW_INTERVAL_S: Final = 0.5
DEFAULT_RPC_TIMEOUT_S: Final = 2.0
_REVOKING_REASONS: Final = frozenset((
    proto.ReleaseReason.TAKEOVER, proto.ReleaseReason.EMERGENCY_STOP, proto.ReleaseReason.HOOK_LOST,
    proto.ReleaseReason.INJECTION_BLOCKED, proto.ReleaseReason.LEASE_REVOKED,
    proto.ReleaseReason.LEASE_EXPIRED, proto.ReleaseReason.INPUT_STOP,
    proto.ReleaseReason.LEASE_SOURCE_LOST, proto.ReleaseReason.SHUTDOWN,
    proto.ReleaseReason.STDIN_CLOSED, proto.ReleaseReason.CORE_CONNECTION_LOST,
))  # fmt: skip


def _noop(_msg: str) -> None:
    return None


def _fmt_release(rel: proto.InputReleasedParams) -> str:
    res = f" residual={len(rel.residual_items)}" if rel.residual_items else ""
    return (
        f"id={rel.release_id} token={rel.token} reason={rel.reason.value} "
        f"ver={rel.verification.value}{res}"
    )


def _fmt_health(h: proto.HealthParams) -> str:
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
        on_event: Callable[[str], None] | None = None,
    ) -> None:
        if (
            min(lease_ttl_s, renew_interval_s, rpc_timeout_s) <= 0
            or renew_interval_s >= lease_ttl_s
        ):
            raise ValueError("invalid lease_ttl_s / renew_interval_s / rpc_timeout_s")
        self.session_id = session_id or f"pm{secrets.token_hex(4)}"
        self.expected_role = expected_role
        self.cred_target = cred_target
        self._ttl_ns = int(lease_ttl_s * 1_000_000_000)
        self._renew_s = renew_interval_s
        self._rpc_timeout_s = rpc_timeout_s
        self._emit: Callable[[str], None] = _noop if on_event is None else on_event
        self.credentials = ch.ChannelCredentials(
            ch.create_channel_path(self.session_id), ch.create_session_key()
        )
        self.session_info: SessionInfo | None = None
        self.last_health: proto.HealthParams | None = None
        self.last_released: proto.InputReleasedParams | None = None
        self.active_token: int | None = None
        self._token = 0
        self._cred_written = False
        self._server: ch.ChannelServer | None = None
        self._peer: ch.RpcPeer | None = None
        self._renew_task: asyncio.Task[None] | None = None
        self._released_event = asyncio.Event()
        self._awaiting_release_id: int | None = None
        self._finalized_release_ids: set[int] = set()
        self._connected_event = asyncio.Event()
        self._closed = False

    @property
    def connected(self) -> bool:
        return self._peer is not None and self._peer.connection.is_open

    async def start(self) -> SessionInfo:
        if self._server is not None:
            raise RuntimeError("PermitServer already started")
        info = SessionInfo.create(self.credentials, self.session_id, launcher_pid=os.getpid())
        self._server = await ch.listen(
            self.credentials.path,
            self.credentials.key,
            on_connection=self._on_connection,
            on_rejected=lambda e: self._emit(f"[permit] rejected: {e}"),
            on_error=lambda e: self._emit(f"[permit] error: {e}"),
        )
        self.session_info = info
        if self.cred_target is not None:
            try:
                write_session_info(info, self.cred_target)
                self._cred_written = True
            except BaseException:
                await self._server.close()
                self._server = None
                raise
        return info

    async def wait_connected(self, timeout: float | None = None) -> None:
        async with asyncio.timeout(timeout):
            await self._connected_event.wait()

    async def grant_start(self) -> int:
        peer = self._require_peer()
        self._cancel_renew()
        token = self._token + 1
        expires_ns = time.perf_counter_ns() + self._ttl_ns
        raw = await peer.request(
            proto.PermitMethods.LEASE_RENEW,
            proto.LeaseRenewParams(token, expires_ns).to_dict(),
            timeout=self._rpc_timeout_s,
        )
        proto.Empty.from_dict(raw)
        self._token = token
        self.active_token = token
        self._renew_task = asyncio.get_running_loop().create_task(self._renew_loop(peer, token))
        return token

    async def pause(self) -> int | None:
        self._cancel_renew()
        token = self.active_token if self.active_token is not None else self._token
        self.active_token = None
        if token <= 0 or not self.connected:
            return None
        raw = await self._require_peer().request(
            proto.PermitMethods.LEASE_REVOKE,
            proto.LeaseRevokeParams(token).to_dict(),
            timeout=self._rpc_timeout_s,
        )
        proto.Empty.from_dict(raw)
        return token

    async def stop_input(self, through_token: int | None = None) -> proto.InputStopResult:
        self._cancel_renew()
        if through_token is None or (
            self.active_token is not None and self.active_token <= through_token
        ):
            self.active_token = None
        raw = await self._require_peer().request(
            proto.PermitMethods.INPUT_STOP,
            proto.InputStopParams(through_token).to_dict(),
            timeout=self._rpc_timeout_s,
        )
        return proto.InputStopResult.from_dict(raw)

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
        self._cancel_renew()
        try:
            if self.connected and self.active_token is not None:
                target_release_id: int | None = None
                with contextlib.suppress(ch.ChannelError, ch.RpcError, proto.ProtocolError):
                    target_release_id = (await self.stop_input(through_token=None)).release_id
                if (
                    target_release_id is not None
                    and target_release_id not in self._finalized_release_ids
                    and self.connected
                ):
                    self._released_event.clear()
                    self._awaiting_release_id = target_release_id
                    try:
                        with contextlib.suppress(TimeoutError):
                            async with asyncio.timeout(release_wait_s):
                                await self._released_event.wait()
                    finally:
                        self._awaiting_release_id = None
        finally:
            peer, self._peer = self._peer, None
            server, self._server = self._server, None
            self._connected_event.clear()
            if peer is not None:
                with contextlib.suppress(Exception):
                    await peer.close()
            if server is not None:
                with contextlib.suppress(Exception):
                    await server.close()
            if self._cred_written and self.cred_target is not None:
                self._cred_written = False
                with contextlib.suppress(CredError):
                    delete_session_info(self.cred_target)

    def _require_peer(self) -> ch.RpcPeer:
        if self._peer is None or not self._peer.connection.is_open:
            raise ch.ChannelError("closed", "realtime-core is not connected")
        return self._peer

    def _cancel_renew(self) -> None:
        if self._renew_task is not None:
            self._renew_task.cancel()
            self._renew_task = None

    def _on_connection(self, conn: ch.Connection) -> None:
        if conn.role != self.expected_role or self.connected:
            conn.abort()
            return
        peer = ch.RpcPeer(conn, timeout=self._rpc_timeout_s)
        peer.on_notification(proto.PermitMethods.INPUT_RELEASED, self._on_released)
        peer.on_notification(proto.PermitMethods.HEALTH, self._on_health)
        peer.closed.add_done_callback(lambda _t: self._on_peer_closed(peer))
        self._finalized_release_ids.clear()
        self._peer = peer
        self._connected_event.set()
        self._emit(f"[permit] realtime-core connected (role={conn.role})")

    def _on_peer_closed(self, peer: ch.RpcPeer) -> None:
        if self._peer is peer:
            self._cancel_renew()
            self.active_token = None
            self._peer = None
            self._connected_event.clear()
            if self._awaiting_release_id is not None:
                self._released_event.set()
            self._emit("[permit] realtime-core disconnected; lease cleared")

    def _on_released(self, raw: dict[str, Any]) -> None:
        try:
            rel = proto.InputReleasedParams.from_dict(raw)
        except proto.ProtocolError as exc:
            self._emit(f"[permit] invalid input.released: {exc}")
            return
        self.last_released = rel
        if rel.verification is not proto.ReleaseVerification.UNVERIFIED:
            if len(self._finalized_release_ids) > 128:
                self._finalized_release_ids.clear()
            self._finalized_release_ids.add(rel.release_id)
            if self._awaiting_release_id == rel.release_id:
                self._released_event.set()
        if rel.reason in _REVOKING_REASONS and (
            self.active_token is not None and (rel.token is None or rel.token >= self.active_token)
        ):
            self._cancel_renew()
            self.active_token = None
        self._emit(f"[released] {_fmt_release(rel)}")

    def _on_health(self, raw: dict[str, Any]) -> None:
        with contextlib.suppress(proto.ProtocolError):
            self.last_health = proto.HealthParams.from_dict(raw)

    async def _renew_loop(self, peer: ch.RpcPeer, token: int) -> None:
        try:
            while self.active_token == token and peer.connection.is_open:
                await asyncio.sleep(self._renew_s)
                if self.active_token != token or not peer.connection.is_open:
                    return
                expires_ns = time.perf_counter_ns() + self._ttl_ns
                proto.Empty.from_dict(
                    await peer.request(
                        proto.PermitMethods.LEASE_RENEW,
                        proto.LeaseRenewParams(token, expires_ns).to_dict(),
                        timeout=self._rpc_timeout_s,
                    )
                )
        except asyncio.CancelledError:
            return
        except (ch.ChannelError, ch.RpcError, proto.ProtocolError) as exc:
            if self.active_token == token:
                self.active_token = None
            self._emit(f"[permit] renewal stopped (token={token}): {exc}")


def _start_stdin_reader(loop: asyncio.AbstractEventLoop) -> asyncio.Queue[str]:
    """Read stdin on a daemon thread so Ctrl+C on Windows never blocks default executor shutdown."""
    queue: asyncio.Queue[str] = asyncio.Queue()

    def _pump() -> None:
        try:
            while True:
                line = sys.stdin.readline()
                with contextlib.suppress(RuntimeError):
                    loop.call_soon_threadsafe(queue.put_nowait, line)
                if not line:
                    return
        except OSError:
            with contextlib.suppress(RuntimeError):
                loop.call_soon_threadsafe(queue.put_nowait, "")

    threading.Thread(target=_pump, name="permit-stdin", daemon=True).start()
    return queue


async def _run_console(args: argparse.Namespace) -> int:
    cred_target = None if args.env_only else args.cred_target
    server = PermitServer(
        session_id=args.session_id,
        expected_role=args.role,
        cred_target=cred_target,
        lease_ttl_s=args.lease_ttl,
        renew_interval_s=args.renew_interval,
        on_event=lambda msg: print(msg, flush=True),
    )
    info = await server.start()
    print(f"Bellis Permit Console ready (session={info.session_id}, pid={info.launcher_pid})")
    if cred_target is not None:
        print(f"  CredMan target: {cred_target} (deleted automatically on exit)")
    else:
        print(f"  $env:{ENV_PERMIT_PATH} = '{server.credentials.path}'")
        print(f"  $env:{ENV_PERMIT_KEY} = '{server.credentials.encoded_key}'")
    print("Commands: start | pause | stop | status | quit", flush=True)
    lines = _start_stdin_reader(asyncio.get_running_loop())
    try:
        while line := await lines.get():
            cmd = line.strip().lower()
            if not cmd:
                continue
            try:
                if cmd == "start":
                    print(f"[ok] lease granted (token={await server.grant_start()})", flush=True)
                elif cmd == "pause":
                    print(f"[ok] lease revoked (token={await server.pause()})", flush=True)
                elif cmd == "stop":
                    res = await server.stop_input(through_token=None)
                    print(f"[ok] input.stop sent (release_id={res.release_id})", flush=True)
                elif cmd == "status":
                    print(server.status_summary(), flush=True)
                elif cmd in {"quit", "exit"}:
                    break
                else:
                    print("Unknown command. Use: start | pause | stop | status | quit", flush=True)
            except (ch.ChannelError, ch.RpcError, proto.ProtocolError) as exc:
                print(f"[err] {exc}", flush=True)
    finally:
        await server.close()
        print("Permit console closed and session cleaned up.", flush=True)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Bellis V2 standalone permit control console.")
    parser.add_argument("--cred-target", default=DEFAULT_SESSION_TARGET)
    parser.add_argument("--env-only", action="store_true")
    parser.add_argument("--session-id", default=None)
    parser.add_argument("--role", default=PERMIT_ROLE)
    parser.add_argument("--lease-ttl", type=float, default=DEFAULT_LEASE_TTL_S)
    parser.add_argument("--renew-interval", type=float, default=DEFAULT_RENEW_INTERVAL_S)
    try:
        return asyncio.run(_run_console(parser.parse_args(argv)))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
