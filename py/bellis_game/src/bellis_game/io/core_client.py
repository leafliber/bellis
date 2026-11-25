"""Controller client and managed subprocess lifecycle for ``realtime-core.exe``."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import math
import os
import secrets
import subprocess
import sys
import threading
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from types import TracebackType
from typing import IO, Any, Final, Self

from bellis_common import channel as ch
from bellis_common.cred import is_session_id

from . import protocol as proto
from .audio_ring import AudioRing
from .frame_ring import FrameRing

logger = logging.getLogger(__name__)

CORE_ROLE: Final = "realtime-core.core"
PERMIT_ROLE: Final = "realtime-core.permit"
ENV_CHANNEL_PATH: Final = "BELLIS_CHANNEL_PATH"
ENV_CHANNEL_KEY: Final = "BELLIS_CHANNEL_KEY"
ENV_ROLE: Final = "BELLIS_ROLE"
ENV_PERMIT_PATH: Final = "BELLIS_PERMIT_PATH"
ENV_PERMIT_KEY: Final = "BELLIS_PERMIT_KEY"
ENV_PERMIT_ROLE: Final = "BELLIS_PERMIT_ROLE"

_WIN_ENV_KEYS = frozenset((
    "APPDATA", "COMPUTERNAME", "COMSPEC", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA",
    "NUMBER_OF_PROCESSORS", "OS", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE",
    "PROGRAMDATA", "PROGRAMFILES", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TMP",
    "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR",
))  # fmt: skip


def _ms(seconds: float) -> str:
    return str(max(1, math.ceil(seconds * 1000)))


def base_environment(source: Mapping[str, str] | None = None) -> dict[str, str]:
    env = os.environ if source is None else source
    return {k: v for k, v in env.items() if k.upper() in _WIN_ENV_KEYS}


class StopStage(StrEnum):
    ALREADY_EXITED = "already-exited"
    SHUTDOWN = "shutdown"
    STDIN_EOF = "stdin-eof"
    KILLED = "killed"


@dataclass(frozen=True, slots=True)
class StopTimeouts:
    shutdown: float = 2.0
    stdin: float = 2.0
    kill: float = 5.0

    def __post_init__(self) -> None:
        if min(self.shutdown, self.stdin, self.kill) <= 0:
            raise ValueError("stop timeouts must be positive")


@dataclass(frozen=True, slots=True)
class StopResult:
    stage: StopStage
    returncode: int | None


type Redirect = int | IO[Any] | None


class ManagedProcess:
    """Direct-argv subprocess with stdin lifeline and RPC -> stdin EOF -> kill stop sequence."""

    def __init__(self, name: str, popen: subprocess.Popen[bytes]) -> None:
        self.name = name
        self._popen = popen
        self._loop = asyncio.get_running_loop()
        self.exited: asyncio.Future[int] = self._loop.create_future()
        threading.Thread(target=self._wait, name=f"{name}-exit", daemon=True).start()

    @classmethod
    def start(
        cls,
        name: str,
        argv: Sequence[str],
        env: Mapping[str, str],
        *,
        stdout: Redirect = None,
        stderr: Redirect = None,
    ) -> ManagedProcess:
        flags = subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0
        popen = subprocess.Popen(
            list(argv),
            stdin=subprocess.PIPE,
            stdout=stdout,
            stderr=stderr,
            env=dict(env),
            creationflags=flags,
        )
        return cls(name, popen)

    @property
    def pid(self) -> int:
        return self._popen.pid

    def close_stdin(self) -> None:
        if self._popen.stdin is not None and not self._popen.stdin.closed:
            with contextlib.suppress(OSError):
                self._popen.stdin.close()

    async def stop(
        self,
        shutdown: Callable[[], Awaitable[object]] | None = None,
        timeouts: StopTimeouts | None = None,
    ) -> StopResult:
        t = timeouts or StopTimeouts()
        if self.exited.done():
            return StopResult(StopStage.ALREADY_EXITED, self.exited.result())
        if shutdown is not None:
            deadline = self._loop.time() + t.shutdown
            try:
                async with asyncio.timeout_at(deadline):
                    await shutdown()
            except Exception as err:
                logger.info("%s shutdown RPC did not finish: %s", self.name, err)
            if await self._wait_exit(deadline - self._loop.time()):
                return StopResult(StopStage.SHUTDOWN, self.exited.result())
        self.close_stdin()
        if await self._wait_exit(t.stdin):
            return StopResult(StopStage.STDIN_EOF, self.exited.result())
        self.kill()
        if await self._wait_exit(t.kill):
            return StopResult(StopStage.KILLED, self.exited.result())
        return StopResult(StopStage.KILLED, None)

    def kill(self) -> None:
        if not self.exited.done():
            with contextlib.suppress(OSError):
                self._popen.kill()

    async def _wait_exit(self, seconds: float) -> bool:
        if not self.exited.done() and seconds > 0:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(asyncio.shield(self.exited), seconds)
        return self.exited.done()

    def _wait(self) -> None:
        rc = self._popen.wait()
        self.close_stdin()
        with contextlib.suppress(RuntimeError):
            self._loop.call_soon_threadsafe(self._finish, rc)

    def _finish(self, rc: int) -> None:
        if not self.exited.done():
            self.exited.set_result(rc)


class CoreStartError(RuntimeError):
    pass


def find_core_executable(repo_root: Path | None = None) -> Path:
    root = Path.cwd() if repo_root is None else repo_root
    for profile in ("release", "debug"):
        cand = root / "core" / "target" / profile / "realtime-core.exe"
        if cand.is_file():
            return cand
    raise FileNotFoundError("realtime-core.exe not found; run `cargo build -p realtime-core`")


@dataclass(frozen=True, slots=True)
class CoreClientOptions:
    executable: Path
    heartbeat_timeout: float = 0.5
    health_interval: float = 1.0
    max_frame_age: float = 0.5
    start_timeout: float = 10.0
    rpc_timeout: float = 2.0
    stop: StopTimeouts = field(default_factory=StopTimeouts)
    role: str = CORE_ROLE
    permit_credentials: ch.ChannelCredentials | None = None
    permit_role: str = PERMIT_ROLE
    permit_cred: str | None = None
    permit_session_id: str | None = None
    emergency_hotkey: str | None = None
    stdout: Redirect = None
    stderr: Redirect = None

    def __post_init__(self) -> None:
        times = (
            self.heartbeat_timeout, self.health_interval, self.max_frame_age,
            self.start_timeout, self.rpc_timeout,
        )  # fmt: skip
        if min(times) <= 0:
            raise ValueError("CoreClientOptions timeouts must be positive")
        if self.permit_credentials is not None and self.permit_cred is not None:
            raise ValueError("specify either permit_credentials or permit_cred, not both")
        if self.permit_session_id is not None and (
            self.permit_cred is None or not is_session_id(self.permit_session_id)
        ):
            raise ValueError("permit_session_id requires valid id and permit_cred")
        if self.permit_cred is not None and (not self.permit_cred or "\0" in self.permit_cred):
            raise ValueError("invalid permit_cred")
        if self.emergency_hotkey is not None and not (self.permit_credentials or self.permit_cred):
            raise ValueError("emergency_hotkey requires a permit source")

    def argv(self) -> list[str]:
        args = [
            str(self.executable), "--heartbeat-timeout-ms", _ms(self.heartbeat_timeout),
            "--health-interval-ms", _ms(self.health_interval),
            "--max-frame-age-ms", _ms(self.max_frame_age),
        ]  # fmt: skip
        if self.permit_cred is not None:
            args += ["--permit-cred", self.permit_cred]
            if self.permit_session_id is not None:
                args += ["--permit-session-id", self.permit_session_id]
        if self.emergency_hotkey is not None:
            args += ["--emergency-hotkey", self.emergency_hotkey]
        return args

    def child_env(self, channel: ch.ChannelCredentials) -> dict[str, str]:
        env = {
            **base_environment(),
            ENV_CHANNEL_PATH: channel.path,
            ENV_CHANNEL_KEY: channel.encoded_key,
            ENV_ROLE: self.role,
        }
        if self.permit_credentials is not None:
            env[ENV_PERMIT_PATH] = self.permit_credentials.path
            env[ENV_PERMIT_KEY] = self.permit_credentials.encoded_key
            env[ENV_PERMIT_ROLE] = self.permit_role
        elif self.permit_cred is not None:
            env[ENV_PERMIT_ROLE] = self.permit_role
        return env


class CoreClient:
    """Explicit controller client for one ``realtime-core.exe`` subprocess lifecycle."""

    def __init__(
        self,
        options: CoreClientOptions,
        *,
        on_released: Callable[[proto.InputReleasedParams], None] | None = None,
        on_receipt: Callable[[proto.ActionReceiptParams], None] | None = None,
        on_health: Callable[[proto.HealthParams], None] | None = None,
    ) -> None:
        self._options = options
        self._on_released = on_released
        self._on_receipt = on_receipt
        self._on_health = on_health
        self._server: ch.ChannelServer | None = None
        self._process: ManagedProcess | None = None
        self._peer: ch.RpcPeer | None = None
        self._creds: contextlib.ExitStack | None = None
        self._ready: asyncio.Future[None] | None = None
        self._hello_done = False
        self.core_version: str | None = None
        self.hello_at_ns: int | None = None
        self.last_health: proto.HealthParams | None = None
        self.last_released: proto.InputReleasedParams | None = None
        self._last_rc: int | None = None

    @property
    def running(self) -> bool:
        return self._process is not None and not self._process.exited.done()

    @property
    def process(self) -> ManagedProcess | None:
        return self._process

    async def start(self) -> None:
        if self._process is not None:
            raise RuntimeError("CoreClient already started")
        ready: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._ready = ready
        self._hello_done = False
        stack = contextlib.ExitStack()
        try:
            creds = stack.enter_context(ch.session_credentials(f"core{secrets.token_hex(4)}"))
            server = await ch.listen(
                creds.path,
                creds.key,
                on_connection=self._on_connection,
                on_rejected=lambda e: logger.warning("rejected core connection: %s", e),
                on_error=lambda e: logger.error("core connection error: %s", e),
            )
            try:
                proc = ManagedProcess.start(
                    "realtime-core",
                    self._options.argv(),
                    self._options.child_env(creds),
                    stdout=self._options.stdout,
                    stderr=self._options.stderr,
                )
            except BaseException:
                await server.close()
                raise
        except BaseException:
            stack.close()
            self._ready = None
            raise

        self._creds, self._server, self._process = stack, server, proc
        try:
            async with asyncio.timeout(self._options.start_timeout):
                await asyncio.wait({ready, proc.exited}, return_when=asyncio.FIRST_COMPLETED)
        except TimeoutError:
            pass
        except BaseException:
            proc.kill()
            await self._cleanup()
            raise
        if not ready.done() or ready.cancelled():
            rc = proc.exited.result() if proc.exited.done() else None
            await self.stop()
            raise CoreStartError(f"realtime-core did not become ready (returncode={rc})")

    async def attach_frame_ring(self, ring: FrameRing | proto.FrameRingAttachParams) -> None:
        params = ring.attach_params() if isinstance(ring, FrameRing) else ring
        proto.Empty.from_dict(
            await self._req(proto.CoreMethods.FRAME_RING_ATTACH, params.to_dict())
        )

    async def set_capture_target(self, target: proto.WindowTargetParams) -> None:
        proto.Empty.from_dict(
            await self._req(proto.CoreMethods.CAPTURE_SET_TARGET, target.to_dict())
        )

    async def attach_audio_ring(self, ring: AudioRing | proto.AudioRingAttachParams) -> None:
        params = ring.attach_params() if isinstance(ring, AudioRing) else ring
        proto.Empty.from_dict(
            await self._req(proto.CoreMethods.AUDIO_RING_ATTACH, params.to_dict())
        )

    async def set_audio_target(self, target: proto.WindowTargetParams) -> None:
        proto.Empty.from_dict(await self._req(proto.CoreMethods.AUDIO_SET_TARGET, target.to_dict()))

    async def configure_input(self, policy: proto.InputPolicy) -> None:
        proto.Empty.from_dict(await self._req(proto.CoreMethods.INPUT_CONFIGURE, policy.to_dict()))

    def send_heartbeat(self, producer: proto.Producer, seq: int) -> None:
        self._require_peer().notify(
            proto.CoreMethods.PRODUCER_HEARTBEAT,
            proto.ProducerHeartbeatParams(producer, seq).to_dict(),
        )

    async def revoke_producer(self, generation: int) -> proto.ProducerRevokeResult:
        raw = await self._req(
            proto.CoreMethods.PRODUCER_REVOKE, proto.ProducerRevokeParams(generation).to_dict()
        )
        return proto.ProducerRevokeResult.from_dict(raw)

    async def submit_action_block(self, block: proto.ActionBlock) -> proto.ActionSubmitResult:
        return proto.parse_action_submit_result(
            await self._req(proto.CoreMethods.ACTION_SUBMIT, block.to_dict())
        )

    async def stop(self) -> StopResult:
        proc = self._process
        if proc is None:
            await self._cleanup()
            return StopResult(StopStage.ALREADY_EXITED, self._last_rc)
        peer = self._peer

        async def _rpc_shutdown() -> None:
            if peer is None or not peer.connection.is_open:
                raise ch.ChannelError("closed", "core connection closed")
            proto.Empty.from_dict(
                await peer.request(
                    proto.CoreMethods.SHUTDOWN, {}, timeout=self._options.stop.shutdown
                )
            )

        res = await proc.stop(_rpc_shutdown, self._options.stop)
        self._last_rc = res.returncode
        await self._cleanup()
        return res

    async def __aenter__(self) -> Self:
        await self.start()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.stop()

    def _require_peer(self) -> ch.RpcPeer:
        if self._peer is None or not self._peer.connection.is_open:
            raise ch.ChannelError("closed", "core connection is not open")
        return self._peer

    async def _req(self, method: str, params: dict[str, Any]) -> object:
        return await self._require_peer().request(method, params, timeout=self._options.rpc_timeout)

    def _on_connection(self, conn: ch.Connection) -> None:
        if conn.role != self._options.role or self._peer is not None:
            conn.abort()
            return
        peer = ch.RpcPeer(conn, timeout=self._options.rpc_timeout)
        peer.handle(proto.CoreMethods.CORE_HELLO, self._handle_hello)
        peer.on_notification(proto.CoreMethods.INPUT_RELEASED, self._handle_released)
        peer.on_notification(proto.CoreMethods.ACTION_RECEIPT, self._handle_receipt)
        peer.on_notification(proto.CoreMethods.HEALTH, self._handle_health)
        self._peer = peer

    def _handle_hello(self, raw: dict[str, Any]) -> dict[str, object]:
        try:
            params = proto.CoreHelloParams.from_dict(raw)
        except proto.ProtocolError as exc:
            raise ch.RpcError(ch.RpcErrorCode.INVALID_PARAMS, str(exc)) from exc
        if params.protocol_version != proto.PROTOCOL_VERSION:
            raise ch.RpcError(
                proto.CoreErrorCode.PROTOCOL_VERSION_MISMATCH, "protocol version mismatch"
            )
        self.core_version = params.core_version
        self.hello_at_ns = time.perf_counter_ns()
        self._hello_done = True
        return proto.CoreHelloResult(protocol_version=proto.PROTOCOL_VERSION).to_dict()

    def _handle_released(self, raw: dict[str, Any]) -> None:
        try:
            rel = proto.InputReleasedParams.from_dict(raw)
        except proto.ProtocolError:
            return
        self.last_released = rel
        if (
            self._hello_done
            and rel.reason is proto.ReleaseReason.CORE_START
            and self._ready is not None
            and not self._ready.done()
        ):
            self._ready.set_result(None)
        if self._on_released is not None:
            self._on_released(rel)

    def _handle_receipt(self, raw: dict[str, Any]) -> None:
        with contextlib.suppress(proto.ProtocolError):
            rec = proto.ActionReceiptParams.from_dict(raw)
            if self._on_receipt is not None:
                self._on_receipt(rec)

    def _handle_health(self, raw: dict[str, Any]) -> None:
        with contextlib.suppress(proto.ProtocolError):
            health = proto.HealthParams.from_dict(raw)
            self.last_health = health
            if self._on_health is not None:
                self._on_health(health)

    async def _cleanup(self) -> None:
        peer, self._peer = self._peer, None
        server, self._server = self._server, None
        creds, self._creds = self._creds, None
        self._process = None
        self._ready = None
        if peer is not None:
            with contextlib.suppress(Exception):
                await peer.close()
        if server is not None:
            with contextlib.suppress(Exception):
                await server.close()
        if creds is not None:
            creds.close()
