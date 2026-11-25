"""Wire primitives for ``bellis-channel/1``: errors, framing, JSON codec, address & key."""

from __future__ import annotations

import base64
import json
import re
import secrets
import struct
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass
from enum import IntEnum
from typing import Literal

type ChannelErrorCode = Literal[
    "address-in-use",
    "address-invalid",
    "invalid-key",
    "busy",
    "connect-failed",
    "auth-failed",
    "handshake-timeout",
    "frame-too-large",
    "protocol-error",
    "timeout",
    "closed",
]


class ChannelError(Exception):
    def __init__(self, code: ChannelErrorCode, message: str) -> None:
        super().__init__(message)
        self.code: ChannelErrorCode = code

    def __repr__(self) -> str:
        return f"ChannelError({self.code!r}, {str(self)!r})"


FRAME_HEADER_BYTES = 5
_HEADER = struct.Struct(">IB")


class FrameKind(IntEnum):
    HANDSHAKE = 0
    JSON = 1
    BINARY = 2


_KINDS = frozenset(int(k) for k in FrameKind)


@dataclass(frozen=True, slots=True)
class Frame:
    kind: FrameKind
    payload: bytes


def encode_frame(kind: FrameKind, payload: bytes) -> bytes:
    return _HEADER.pack(len(payload), kind) + payload


def parse_header(header: bytes, max_payload_bytes: int) -> tuple[FrameKind, int]:
    length, kind = _HEADER.unpack(header)
    if kind not in _KINDS:
        raise ChannelError("protocol-error", f"unknown frame kind {kind}")
    if length > max_payload_bytes:
        raise ChannelError("frame-too-large", f"frame {length}B exceeds {max_payload_bytes}B")
    return FrameKind(kind), length


class FrameDecoder:
    def __init__(self, max_payload_bytes: int) -> None:
        self.max_payload_bytes = max_payload_bytes
        self._buf = bytearray()

    @property
    def buffered_bytes(self) -> int:
        return len(self._buf)

    def push(self, chunk: bytes) -> None:
        self._buf += chunk

    def read(self) -> Frame | None:
        if len(self._buf) < FRAME_HEADER_BYTES:
            return None
        kind, length = parse_header(bytes(self._buf[:FRAME_HEADER_BYTES]), self.max_payload_bytes)
        end = FRAME_HEADER_BYTES + length
        if len(self._buf) < end:
            return None
        payload = bytes(self._buf[FRAME_HEADER_BYTES:end])
        del self._buf[:end]
        return Frame(kind, payload)


def dumps(message: object) -> bytes:
    return json.dumps(message, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def _reject_constant(name: str) -> object:
    raise ValueError(f"JSON constant {name} is not allowed")


def loads(payload: bytes, *, what: str = "message") -> object:
    text = payload.decode("utf-8", errors="replace")
    try:
        return json.loads(text, parse_constant=_reject_constant)
    except (ValueError, RecursionError) as err:
        raise ChannelError("protocol-error", f"invalid JSON in {what}") from err


SESSION_KEY_BYTES = 32
MAX_UDS_PATH_BYTES = 103
PIPE_PREFIX = "\\\\.\\pipe\\"
_SESSION_ID = re.compile(r"[a-z0-9]{1,16}")
_KEY_TEXT = re.compile(r"[A-Za-z0-9_-]{43}")


def channel_name(session_id: str, random: bytes) -> str:
    if _SESSION_ID.fullmatch(session_id) is None:
        raise ChannelError("address-invalid", f"invalid session_id: {session_id!r}")
    token = base64.b32encode(random).decode("ascii").rstrip("=").lower()
    return f"bellis-{session_id}-{token}"


def create_channel_path(session_id: str) -> str:
    return PIPE_PREFIX + channel_name(session_id, secrets.token_bytes(16))


def create_session_key() -> bytes:
    return secrets.token_bytes(SESSION_KEY_BYTES)


def check_session_key(key: bytes) -> None:
    if len(key) != SESSION_KEY_BYTES:
        raise ChannelError("invalid-key", f"session key must be {SESSION_KEY_BYTES} bytes")


def encode_session_key(key: bytes) -> str:
    return base64.urlsafe_b64encode(key).decode("ascii").rstrip("=")


def decode_session_key(text: str) -> bytes:
    if _KEY_TEXT.fullmatch(text) is not None:
        key = base64.urlsafe_b64decode(text + "=")
        if encode_session_key(key) == text:
            return key
    raise ChannelError("address-invalid", "invalid session key encoding")


@dataclass(frozen=True, slots=True)
class ChannelCredentials:
    path: str
    key: bytes

    def __post_init__(self) -> None:
        check_session_key(self.key)

    @property
    def encoded_key(self) -> str:
        return encode_session_key(self.key)

    @classmethod
    def decode(cls, path: str, encoded_key: str) -> ChannelCredentials:
        return cls(path, decode_session_key(encoded_key))

    def __repr__(self) -> str:
        return f"ChannelCredentials(path={self.path!r}, key=<redacted>)"


@contextmanager
def session_credentials(session_id: str) -> Generator[ChannelCredentials]:
    yield ChannelCredentials(create_channel_path(session_id), create_session_key())
