"""Mutual HMAC-SHA256 handshake state machines for ``bellis-channel/1`` (pure, no IO)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
from typing import cast

from .wire import ChannelError, Frame, FrameKind, check_session_key, dumps, encode_frame, loads

PROOF_DOMAIN = "bellis-channel/1"
NONCE_BYTES = 32
HANDSHAKE_MAX_FRAME_BYTES = 1024
DEFAULT_HANDSHAKE_TIMEOUT = 2.0
DEFAULT_MAX_FRAME_BYTES = 1024 * 1024
_BYTES32 = re.compile(r"[A-Za-z0-9_-]{43}")
_ROLE = re.compile(r"[a-z][a-z0-9_.:-]{0,63}")


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _decode_bytes32(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=")


def mac(
    key: bytes,
    direction: str,
    role: str,
    client_nonce: str,
    server_nonce: str,
    *,
    domain: str = PROOF_DOMAIN,
) -> bytes:
    record = dumps([domain, direction, role, client_nonce, server_nonce])
    return hmac.new(key, record, hashlib.sha256).digest()


def is_valid_role(role: object) -> bool:
    return isinstance(role, str) and _ROLE.fullmatch(role) is not None


def _is_version(value: object) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and value == 1


def _bytes32(value: object) -> str | None:
    return value if isinstance(value, str) and _BYTES32.fullmatch(value) is not None else None


def _closed_object(message: object, kind: str, keys: frozenset[str]) -> dict[str, object] | None:
    if not isinstance(message, dict):
        return None
    fields = cast("dict[str, object]", message)
    if fields.keys() != keys or not _is_version(fields["v"]) or fields["type"] != kind:
        return None
    return fields


def parse_hello(message: object) -> tuple[str, str] | None:
    fields = _closed_object(message, "hello", frozenset({"v", "type", "role", "nonce"}))
    if fields is None:
        return None
    role, nonce = fields["role"], _bytes32(fields["nonce"])
    return (role, nonce) if isinstance(role, str) and is_valid_role(role) and nonce else None


def parse_challenge(message: object) -> tuple[str, str] | None:
    fields = _closed_object(message, "challenge", frozenset({"v", "type", "nonce", "proof"}))
    if fields is None:
        return None
    nonce, proof = _bytes32(fields["nonce"]), _bytes32(fields["proof"])
    return (nonce, proof) if nonce and proof else None


def parse_proof(message: object) -> str | None:
    fields = _closed_object(message, "proof", frozenset({"v", "type", "proof"}))
    return None if fields is None else _bytes32(fields["proof"])


def is_accept(message: object) -> bool:
    return _closed_object(message, "accept", frozenset({"v", "type"})) is not None


def _hs_msg(frame: Frame) -> object:
    if frame.kind != FrameKind.HANDSHAKE:
        raise ChannelError("protocol-error", "data frame received before auth")
    return loads(frame.payload, what="handshake")


def _hs_frame(message: dict[str, object]) -> bytes:
    return encode_frame(FrameKind.HANDSHAKE, dumps(message))


def _check_nonce(nonce: bytes) -> str:
    if len(nonce) != NONCE_BYTES:
        raise ValueError(f"nonce must be {NONCE_BYTES} bytes")
    return b64url(nonce)


class ClientHandshake:
    def __init__(self, key: bytes, role: str, nonce: bytes) -> None:
        check_session_key(key)
        if not is_valid_role(role):
            raise ChannelError("protocol-error", f"invalid role: {role}")
        self._key = key
        self.role = role
        self._nonce = _check_nonce(nonce)

    def hello(self) -> bytes:
        return _hs_frame({"v": 1, "type": "hello", "role": self.role, "nonce": self._nonce})

    def on_challenge(self, frame: Frame) -> bytes:
        challenge = parse_challenge(_hs_msg(frame))
        if challenge is None:
            raise ChannelError("protocol-error", "invalid challenge")
        server_nonce, proof = challenge
        expected = mac(self._key, "server", self.role, self._nonce, server_nonce)
        if not hmac.compare_digest(_decode_bytes32(proof), expected):
            raise ChannelError("auth-failed", "server proof verification failed")
        own = b64url(mac(self._key, "client", self.role, self._nonce, server_nonce))
        return _hs_frame({"v": 1, "type": "proof", "proof": own})

    def on_accept(self, frame: Frame) -> None:
        if not is_accept(_hs_msg(frame)):
            raise ChannelError("protocol-error", "invalid accept")


class ServerHandshake:
    def __init__(self, key: bytes, nonce: bytes) -> None:
        check_session_key(key)
        self._key = key
        self._nonce = _check_nonce(nonce)
        self._hello: tuple[str, str] | None = None

    def on_hello(self, frame: Frame) -> bytes:
        hello = parse_hello(_hs_msg(frame))
        if hello is None:
            raise ChannelError("protocol-error", "invalid hello")
        self._hello = hello
        role, client_nonce = hello
        proof = b64url(mac(self._key, "server", role, client_nonce, self._nonce))
        return _hs_frame({"v": 1, "type": "challenge", "nonce": self._nonce, "proof": proof})

    def on_proof(self, frame: Frame) -> tuple[str, bytes]:
        if self._hello is None:
            raise RuntimeError("on_hello has not succeeded yet")
        role, client_nonce = self._hello
        proof = parse_proof(_hs_msg(frame))
        if proof is None:
            raise ChannelError("protocol-error", "invalid proof")
        expected = mac(self._key, "client", role, client_nonce, self._nonce)
        if not hmac.compare_digest(_decode_bytes32(proof), expected):
            raise ChannelError("auth-failed", f"client ({role}) proof verification failed")
        return role, _hs_frame({"v": 1, "type": "accept"})
