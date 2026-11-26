"""Direct-argv subprocess wrapper with stdin lifeline and graceful stop sequence."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import subprocess
import sys
import threading
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import IO, Any

logger = logging.getLogger(__name__)

_WIN_ENV_KEYS = frozenset((
    "APPDATA", "COMPUTERNAME", "COMSPEC", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA",
    "NUMBER_OF_PROCESSORS", "OS", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE",
    "PROGRAMDATA", "PROGRAMFILES", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TMP",
    "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR",
))  # fmt: skip


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
