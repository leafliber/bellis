"""Windows named pipe listener and stream opener (``CreateNamedPipeW`` + ProactorEventLoop)."""

from __future__ import annotations

import sys

if sys.platform != "win32":
    raise ImportError("_winpipe is Windows-only")

import asyncio
import ctypes
from asyncio import windows_utils
from collections.abc import Callable
from ctypes import wintypes
from typing import Any, Protocol, cast

from bellis_common._winsecurity import (
    SecurityAttributes,
    SecurityDescriptor,
    current_user_only_sddl,
)

from .wire import ChannelError

STREAM_LIMIT = 1024 * 1024
type StreamCallback = Callable[[asyncio.StreamReader, asyncio.StreamWriter], None]

_PIPE_ACCESS_DUPLEX = 0x00000003
_FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000
_FILE_FLAG_OVERLAPPED = 0x40000000
_PIPE_REJECT_REMOTE_CLIENTS = 0x00000008
_PIPE_UNLIMITED_INSTANCES = 255
_PIPE_BUFFER_BYTES = 64 * 1024
_ERROR_ACCESS_DENIED = 5
_INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
_k32 = ctypes.WinDLL("kernel32", use_last_error=True)

_CreateNamedPipeW: Any = _k32.CreateNamedPipeW
_CreateNamedPipeW.restype = wintypes.HANDLE
_CreateNamedPipeW.argtypes = (
    wintypes.LPCWSTR,
    wintypes.DWORD,
    wintypes.DWORD,
    wintypes.DWORD,
    wintypes.DWORD,
    wintypes.DWORD,
    wintypes.DWORD,
    wintypes.LPVOID,
)


def create_pipe_instance(
    address: str, security: SecurityAttributes, *, first: bool
) -> windows_utils.PipeHandle:
    flags = _PIPE_ACCESS_DUPLEX | _FILE_FLAG_OVERLAPPED
    if first:
        flags |= _FILE_FLAG_FIRST_PIPE_INSTANCE
    handle = _CreateNamedPipeW(
        address,
        flags,
        _PIPE_REJECT_REMOTE_CLIENTS,
        _PIPE_UNLIMITED_INSTANCES,
        _PIPE_BUFFER_BYTES,
        _PIPE_BUFFER_BYTES,
        0,
        ctypes.byref(security),
    )
    if handle is None or handle == _INVALID_HANDLE_VALUE:
        code = ctypes.get_last_error()
        if first and code == _ERROR_ACCESS_DENIED:
            raise ChannelError("address-in-use", f"pipe address already exists: {address}")
        raise ctypes.WinError(code)
    return windows_utils.PipeHandle(handle)


class _Proactor(Protocol):
    def accept_pipe(self, pipe: windows_utils.PipeHandle) -> asyncio.Future[Any]: ...


class NamedPipeListener:
    """Accepts named-pipe connections with current-user DACL and first-instance protection."""

    def __init__(
        self, loop: asyncio.AbstractEventLoop, address: str, on_stream: StreamCallback
    ) -> None:
        if not isinstance(loop, asyncio.ProactorEventLoop):
            raise ChannelError("address-invalid", "named pipes require ProactorEventLoop")
        self._loop: Any = loop
        self._address = address
        self._on_stream = on_stream
        self._closed = False
        self._security = SecurityDescriptor(current_user_only_sddl())
        self._free: set[windows_utils.PipeHandle] = set()
        self._accepting: tuple[asyncio.Future[Any], windows_utils.PipeHandle] | None = None
        self._tasks: set[asyncio.Task[None]] = set()
        try:
            self._spare = self._create(first=True)
        except BaseException:
            self._security.free()
            raise
        loop.call_soon(self._accept_next)

    def _create(self, *, first: bool) -> windows_utils.PipeHandle:
        pipe = create_pipe_instance(self._address, self._security.attributes, first=first)
        self._free.add(pipe)
        return pipe

    def _accept_next(self) -> None:
        if self._closed:
            return
        try:
            pipe, self._spare = self._spare, self._create(first=False)
        except OSError as error:
            self._loop.call_exception_handler(
                {"message": f"named pipe create failed: {self._address}", "exception": error}
            )
            self._loop.call_later(1.0, self._accept_next)
            return
        try:
            proactor = cast(_Proactor, self._loop._proactor)
            accepting = proactor.accept_pipe(pipe)
        except OSError:
            self._discard(pipe)
            self._loop.call_soon(self._accept_next)
            return
        self._accepting = (accepting, pipe)
        accepting.add_done_callback(self._on_accepted)

    def _on_accepted(self, done: asyncio.Future[Any]) -> None:
        if self._accepting is None:
            return
        _, pipe = self._accepting
        self._accepting = None
        try:
            done.result()
        except asyncio.CancelledError:
            self._discard(pipe)
            return
        except OSError as error:
            self._discard(pipe)
            if not isinstance(error, BrokenPipeError) and not self._closed:
                self._loop.call_exception_handler(
                    {"message": f"named pipe accept failed: {self._address}", "exception": error}
                )
        else:
            self._free.discard(pipe)
            if self._closed:
                pipe.close()
                return
            task = self._loop.create_task(self._connected(pipe))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
        self._accept_next()

    def _discard(self, pipe: windows_utils.PipeHandle) -> None:
        self._free.discard(pipe)
        pipe.close()

    async def _connected(self, pipe: windows_utils.PipeHandle) -> None:
        reader = asyncio.StreamReader(limit=STREAM_LIMIT, loop=self._loop)
        protocol = asyncio.StreamReaderProtocol(reader, loop=self._loop)
        waiter: asyncio.Future[None] = self._loop.create_future()
        transport = cast(
            asyncio.Transport,
            self._loop._make_duplex_pipe_transport(pipe, protocol, waiter, {"addr": self._address}),
        )
        try:
            await waiter
        except BaseException:
            transport.abort()
            raise
        self._on_stream(reader, asyncio.StreamWriter(transport, protocol, reader, self._loop))

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._accepting is not None:
            self._accepting[0].cancel()
        for pipe in list(self._free):
            self._discard(pipe)
        for task in list(self._tasks):
            task.cancel()
        self._security.free()


async def open_stream(path: str) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    try:
        loop = asyncio.get_running_loop()
        if not isinstance(loop, asyncio.ProactorEventLoop):
            raise ChannelError("connect-failed", "named pipes require ProactorEventLoop")
        reader = asyncio.StreamReader(limit=STREAM_LIMIT, loop=loop)
        protocol = asyncio.StreamReaderProtocol(reader, loop=loop)
        transport, _ = await loop.create_pipe_connection(lambda: protocol, path)
        return reader, asyncio.StreamWriter(transport, protocol, reader, loop)
    except OSError as error:
        raise ChannelError("connect-failed", f"cannot connect to channel: {error}") from error


async def start_listener(path: str, on_stream: StreamCallback) -> NamedPipeListener:
    return NamedPipeListener(asyncio.get_running_loop(), path, on_stream)
