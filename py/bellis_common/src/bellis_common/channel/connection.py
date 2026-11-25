"""Authenticated ``bellis-channel/1`` Connection, ChannelServer, ``listen``, and ``connect``."""

from __future__ import annotations

import asyncio
import secrets
import weakref
from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from typing import Any

from ._winpipe import NamedPipeListener, open_stream, start_listener
from .handshake import (
    DEFAULT_HANDSHAKE_TIMEOUT,
    DEFAULT_MAX_FRAME_BYTES,
    HANDSHAKE_MAX_FRAME_BYTES,
    NONCE_BYTES,
    ClientHandshake,
    ServerHandshake,
    is_valid_role,
)
from .wire import (
    FRAME_HEADER_BYTES,
    ChannelError,
    Frame,
    FrameKind,
    check_session_key,
    dumps,
    encode_frame,
    loads,
    parse_header,
)

CLOSE_GRACE = 1.0
DEFAULT_MAX_PENDING_HANDSHAKES = 16


@dataclass(frozen=True, slots=True)
class JsonMessage:
    value: Any


@dataclass(frozen=True, slots=True)
class BinaryMessage:
    data: bytes


type Message = JsonMessage | BinaryMessage


class _FrameReader:
    def __init__(self, reader: asyncio.StreamReader) -> None:
        self._reader = reader
        self._header: tuple[FrameKind, int] | None = None

    async def read(self, max_payload_bytes: int) -> Frame:
        try:
            if self._header is None:
                head = await self._reader.readexactly(FRAME_HEADER_BYTES)
                self._header = parse_header(head, max_payload_bytes)
            kind, length = self._header
            payload = await self._reader.readexactly(length)
        except asyncio.IncompleteReadError as error:
            raise ChannelError("closed", "connection closed") from error
        except OSError as error:
            raise ChannelError("closed", f"connection lost: {error}") from error
        self._header = None
        return Frame(kind, payload)


async def _handshake[T](
    run: Coroutine[Any, Any, T], writer: asyncio.StreamWriter, timeout: float
) -> T:
    try:
        async with asyncio.timeout(timeout):
            return await run
    except TimeoutError:
        writer.transport.abort()
        raise ChannelError("handshake-timeout", "handshake timed out") from None
    except ChannelError as error:
        writer.transport.abort()
        if error.code == "closed":
            raise ChannelError("closed", "connection closed before handshake finished") from error
        raise
    except BaseException:
        writer.transport.abort()
        raise


class Connection:
    """Authenticated ``bellis-channel/1`` connection returned by ``accept`` or ``open``."""

    def __init__(
        self,
        frames: _FrameReader,
        writer: asyncio.StreamWriter,
        role: str,
        max_frame_bytes: int,
    ) -> None:
        self._frames = frames
        self._writer = writer
        self._max_frame_bytes = max_frame_bytes
        self._failed: ChannelError | None = None
        self.role = role

    @classmethod
    async def accept(
        cls,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        key: bytes,
        *,
        handshake_timeout: float = DEFAULT_HANDSHAKE_TIMEOUT,
        max_frame_bytes: int = DEFAULT_MAX_FRAME_BYTES,
        nonce: bytes | None = None,
    ) -> Connection:
        check_session_key(key)
        hs = ServerHandshake(key, secrets.token_bytes(NONCE_BYTES) if nonce is None else nonce)
        frames = _FrameReader(reader)

        async def run() -> str:
            writer.write(hs.on_hello(await frames.read(HANDSHAKE_MAX_FRAME_BYTES)))
            role, accept = hs.on_proof(await frames.read(HANDSHAKE_MAX_FRAME_BYTES))
            writer.write(accept)
            return role

        return cls(
            frames, writer, await _handshake(run(), writer, handshake_timeout), max_frame_bytes
        )

    @classmethod
    async def open(
        cls,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        role: str,
        key: bytes,
        *,
        handshake_timeout: float = DEFAULT_HANDSHAKE_TIMEOUT,
        max_frame_bytes: int = DEFAULT_MAX_FRAME_BYTES,
        nonce: bytes | None = None,
    ) -> Connection:
        check_session_key(key)
        try:
            hs = ClientHandshake(
                key, role, secrets.token_bytes(NONCE_BYTES) if nonce is None else nonce
            )
        except ChannelError:
            writer.transport.abort()
            raise
        frames = _FrameReader(reader)

        async def run() -> None:
            writer.write(hs.hello())
            writer.write(hs.on_challenge(await frames.read(HANDSHAKE_MAX_FRAME_BYTES)))
            hs.on_accept(await frames.read(HANDSHAKE_MAX_FRAME_BYTES))

        await _handshake(run(), writer, handshake_timeout)
        return cls(frames, writer, role, max_frame_bytes)

    @property
    def is_open(self) -> bool:
        return self._failed is None and not self._writer.is_closing()

    def send(self, message: object) -> None:
        self._write(FrameKind.JSON, dumps(message))

    def send_binary(self, data: bytes) -> None:
        self._write(FrameKind.BINARY, data)

    async def receive(
        self, timeout: float | None = None, *, json_decoder: Callable[[bytes], object] = loads
    ) -> Message:
        if self._failed is not None:
            raise self._failed
        try:
            async with asyncio.timeout(timeout):
                frame = await self._frames.read(self._max_frame_bytes)
        except TimeoutError:
            raise ChannelError("timeout", f"no message within {timeout}s") from None
        except ChannelError as error:
            raise self._fail(error) from None
        if frame.kind == FrameKind.BINARY:
            return BinaryMessage(frame.payload)
        if frame.kind == FrameKind.HANDSHAKE:
            raise self._fail(ChannelError("protocol-error", "handshake frame after auth"))
        try:
            return JsonMessage(json_decoder(frame.payload))
        except ChannelError as error:
            raise self._fail(error) from None

    async def close(self) -> None:
        if self._writer.is_closing():
            return
        self._writer.close()
        try:
            async with asyncio.timeout(CLOSE_GRACE):
                await self._writer.wait_closed()
        except (TimeoutError, OSError):
            self._writer.transport.abort()

    def abort(self) -> None:
        if self._failed is None:
            self._failed = ChannelError("closed", "connection aborted")
        self._writer.transport.abort()

    def _fail(self, error: ChannelError) -> ChannelError:
        if self._failed is None:
            self._failed = error
        self._writer.transport.abort()
        return error

    def _write(self, kind: FrameKind, payload: bytes) -> None:
        if not self.is_open:
            raise ChannelError("closed", "connection is not open")
        if len(payload) > self._max_frame_bytes:
            raise ChannelError("frame-too-large", f"payload exceeds {self._max_frame_bytes}B")
        self._writer.write(encode_frame(kind, payload))


class ChannelServer:
    """Listening channel server created by ``listen``."""

    def __init__(
        self,
        path: str,
        key: bytes,
        *,
        on_connection: Callable[[Connection], None],
        on_rejected: Callable[[ChannelError], None],
        on_error: Callable[[BaseException], None],
        handshake_timeout: float,
        max_frame_bytes: int,
        max_pending_handshakes: int,
    ) -> None:
        check_session_key(key)
        self.path = path
        self._key = key
        self._on_connection = on_connection
        self._on_rejected = on_rejected
        self._on_error = on_error
        self._handshake_timeout = handshake_timeout
        self._max_frame_bytes = max_frame_bytes
        self._max_pending = max_pending_handshakes
        self._pending = 0
        self._listener: NamedPipeListener | None = None
        self._writers: weakref.WeakSet[asyncio.StreamWriter] = weakref.WeakSet()
        self._tasks: set[asyncio.Task[None]] = set()
        self._closed = False

    async def start(self) -> None:
        if self._listener is not None or self._closed:
            raise RuntimeError("ChannelServer can only be started once")
        self._listener = await start_listener(self.path, self._on_stream)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._listener is not None:
            await self._listener.close()
        for task in list(self._tasks):
            task.cancel()
        for writer in list(self._writers):
            writer.transport.abort()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)

    def _on_stream(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        if self._closed:
            writer.transport.abort()
            return
        if self._pending >= self._max_pending:
            writer.transport.abort()
            self._on_rejected(ChannelError("busy", "too many pending handshakes"))
            return
        self._pending += 1
        self._writers.add(writer)
        task = asyncio.get_running_loop().create_task(self._handshake(reader, writer))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _handshake(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            conn = await Connection.accept(
                reader,
                writer,
                self._key,
                handshake_timeout=self._handshake_timeout,
                max_frame_bytes=self._max_frame_bytes,
            )
        except ChannelError as error:
            self._on_rejected(error)
            return
        finally:
            self._pending -= 1
        try:
            self._on_connection(conn)
        except Exception as error:
            conn.abort()
            self._on_error(error)


async def listen(
    path: str,
    key: bytes,
    *,
    on_connection: Callable[[Connection], None],
    on_rejected: Callable[[ChannelError], None],
    on_error: Callable[[BaseException], None],
    handshake_timeout: float = DEFAULT_HANDSHAKE_TIMEOUT,
    max_frame_bytes: int = DEFAULT_MAX_FRAME_BYTES,
    max_pending_handshakes: int = DEFAULT_MAX_PENDING_HANDSHAKES,
) -> ChannelServer:
    server = ChannelServer(
        path,
        key,
        on_connection=on_connection,
        on_rejected=on_rejected,
        on_error=on_error,
        handshake_timeout=handshake_timeout,
        max_frame_bytes=max_frame_bytes,
        max_pending_handshakes=max_pending_handshakes,
    )
    await server.start()
    return server


async def connect(
    path: str,
    role: str,
    key: bytes,
    *,
    handshake_timeout: float = DEFAULT_HANDSHAKE_TIMEOUT,
    max_frame_bytes: int = DEFAULT_MAX_FRAME_BYTES,
) -> Connection:
    check_session_key(key)
    if not is_valid_role(role):
        raise ChannelError("protocol-error", f"invalid role: {role}")
    try:
        async with asyncio.timeout(handshake_timeout):
            reader, writer = await open_stream(path)
    except TimeoutError:
        raise ChannelError("connect-failed", "connect timed out") from None
    return await Connection.open(
        reader,
        writer,
        role,
        key,
        handshake_timeout=handshake_timeout,
        max_frame_bytes=max_frame_bytes,
    )
