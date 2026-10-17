"""本机通道的 Python 客户端（D-12、R-05），与 `packages/channel` 逐字节兼容。

帧：4 字节大端负载长度 + 1 字节类型（0 握手、1 JSON、2 二进制）+ 负载。
握手：客户端发 hello；服务端回 challenge，先证明持有会话密钥；
客户端核验后回 proof；服务端回 accept。
证明为 HMAC-SHA256(会话密钥, JSON([域, 方向, 角色, 客户端随机数, 服务端随机数]))，base64url 无填充。
服务端未能证明时立即断开，不回送证明，也不发任何业务数据（地址可能被抢注）。
握手消息按 `packages/protocol` 生成的模型校验。
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import hmac
import json
import secrets
import struct
import sys
from typing import Any

from pydantic import BaseModel, ValidationError

from .protocol import ChannelAccept, ChannelChallenge, ChannelHello

PROOF_DOMAIN = 'bellis-channel/1'
SESSION_KEY_BYTES = 32

KIND_HANDSHAKE = 0
KIND_JSON = 1
KIND_BINARY = 2
_KINDS = (KIND_HANDSHAKE, KIND_JSON, KIND_BINARY)
_HEADER = struct.Struct('>IB')

HANDSHAKE_MAX_FRAME_BYTES = 1024
DEFAULT_MAX_FRAME_BYTES = 1024 * 1024
DEFAULT_HANDSHAKE_TIMEOUT = 2.0
TCP_PREFIX = 'tcp:'


class ChannelError(Exception):
    """与 Node 侧 ChannelError 的错误码一致，例如 `auth-failed`、`protocol-error`、`closed`。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def decode_session_key(text: str) -> bytes:
    """会话密钥须是 32 字节随机数的 base64url（无填充）编码。"""
    try:
        key = b64url_decode(text)
    except ValueError as error:
        raise ChannelError('invalid-key', '会话密钥格式不正确') from error
    if len(key) != SESSION_KEY_BYTES or b64url(key) != text:
        raise ChannelError('invalid-key', '会话密钥格式不正确')
    return key


def mac(key: bytes, direction: str, role: str, client_nonce: str, server_nonce: str) -> bytes:
    """握手证明。序列化须与 Node 的 `JSON.stringify` 完全一致：紧凑分隔符、不转义非 ASCII。"""
    record = dumps([PROOF_DOMAIN, direction, role, client_nonce, server_nonce])
    return hmac.new(key, record, hashlib.sha256).digest()


def dumps(message: object) -> bytes:
    """紧凑 UTF-8 JSON，与 Node 的 `JSON.stringify` 输出一致。"""
    return json.dumps(message, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def encode_frame(kind: int, payload: bytes) -> bytes:
    return _HEADER.pack(len(payload), kind) + payload


async def read_frame(reader: asyncio.StreamReader, max_payload: int) -> tuple[int, bytes]:
    """读一整帧。帧头非法或超长时抛出 ChannelError，对端关闭时抛出 `closed`。"""
    try:
        length, kind = _HEADER.unpack(await reader.readexactly(_HEADER.size))
        if kind not in _KINDS:
            raise ChannelError('protocol-error', f'未知的帧类型 {kind}')
        if length > max_payload:
            raise ChannelError('frame-too-large', f'帧长 {length} 超过上限 {max_payload}')
        return kind, await reader.readexactly(length)
    except asyncio.IncompleteReadError as error:
        raise ChannelError('closed', '连接已关闭') from error
    except OSError as error:
        raise ChannelError('closed', f'连接已断开：{error}') from error


async def open_stream(path: str) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    """按地址打开字节流：`tcp:主机:端口` 只供测试，其余为命名管道（Windows）或 UDS。"""
    if path.startswith(TCP_PREFIX):
        host, _, port = path.removeprefix(TCP_PREFIX).rpartition(':')
        return await asyncio.open_connection(host, int(port), limit=DEFAULT_MAX_FRAME_BYTES)
    if sys.platform == 'win32':
        loop = asyncio.get_running_loop()
        if not isinstance(loop, asyncio.ProactorEventLoop):
            raise ChannelError('connect-failed', '命名管道需要 ProactorEventLoop')
        reader = asyncio.StreamReader(limit=DEFAULT_MAX_FRAME_BYTES)
        protocol = asyncio.StreamReaderProtocol(reader)
        transport, _ = await loop.create_pipe_connection(lambda: protocol, path)
        return reader, asyncio.StreamWriter(transport, protocol, reader, loop)
    return await asyncio.open_unix_connection(path, limit=DEFAULT_MAX_FRAME_BYTES)


class Connection:
    """一条已认证的本机连接。只由 `connect` 在握手成功后交出。"""

    def __init__(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        role: str,
        max_frame_bytes: int,
    ) -> None:
        self.role = role
        self._reader = reader
        self._writer = writer
        self._max_frame_bytes = max_frame_bytes

    @property
    def is_open(self) -> bool:
        return not self._writer.is_closing()

    def send(self, message: object) -> None:
        """发送一条 JSON 消息。连接已关闭或超出帧长上限时抛出 ChannelError。"""
        self._write(KIND_JSON, dumps(message))

    def send_binary(self, data: bytes) -> None:
        """发送一帧二进制数据；调用方随后 `await drain()` 施加背压。"""
        self._write(KIND_BINARY, data)

    async def drain(self) -> None:
        try:
            await self._writer.drain()
        except OSError as error:
            raise ChannelError('closed', f'连接已断开：{error}') from error

    async def receive(self) -> tuple[int, Any]:
        """下一帧：JSON 帧返回解析后的值，二进制帧返回 bytes。认证后再收到握手帧即为协议错误。"""
        kind, payload = await read_frame(self._reader, self._max_frame_bytes)
        if kind == KIND_HANDSHAKE:
            raise ChannelError('protocol-error', '认证后收到握手帧')
        if kind == KIND_BINARY:
            return kind, payload
        try:
            return kind, json.loads(payload)
        except ValueError as error:
            raise ChannelError('protocol-error', '消息不是合法 JSON') from error

    async def close(self) -> None:
        """正常关闭：先把已写入的数据送出，再关闭。"""
        if self._writer.is_closing():
            return
        with contextlib.suppress(OSError, ChannelError):
            await self.drain()
        self._writer.close()
        with contextlib.suppress(OSError):
            await self._writer.wait_closed()

    def _write(self, kind: int, payload: bytes) -> None:
        if self._writer.is_closing():
            raise ChannelError('closed', '连接未打开')
        if len(payload) > self._max_frame_bytes:
            raise ChannelError(
                'frame-too-large', f'负载 {len(payload)} 字节超过上限 {self._max_frame_bytes}'
            )
        self._writer.write(encode_frame(kind, payload))


async def connect(
    path: str,
    role: str,
    key: bytes,
    *,
    handshake_timeout: float = DEFAULT_HANDSHAKE_TIMEOUT,
    max_frame_bytes: int = DEFAULT_MAX_FRAME_BYTES,
) -> Connection:
    """以给定角色连接并完成握手。服务端未能证明持有密钥时以 `auth-failed` 失败。"""
    if len(key) != SESSION_KEY_BYTES:
        raise ChannelError('invalid-key', f'会话密钥须为 {SESSION_KEY_BYTES} 字节')
    client_nonce = b64url(secrets.token_bytes(32))
    try:
        hello = ChannelHello(v=1, type='hello', role=role, nonce=client_nonce)
    except ValidationError as error:
        raise ChannelError('protocol-error', f'角色名不合法：{role}') from error
    try:
        reader, writer = await open_stream(path)
    except OSError as error:
        raise ChannelError('connect-failed', f'无法连接通道：{error}') from error
    try:
        async with asyncio.timeout(handshake_timeout):
            await _handshake(reader, writer, hello, key)
    except TimeoutError as error:
        writer.close()
        raise ChannelError('handshake-timeout', f'握手未在 {handshake_timeout}s 内完成') from error
    except BaseException:
        writer.close()
        raise
    return Connection(reader, writer, role, max_frame_bytes)


def _check[M: BaseModel](model: type[M], message: object) -> M:
    try:
        return model.model_validate(message, strict=True)
    except ValidationError as error:
        raise ChannelError('protocol-error', f'握手消息不合法，期望 {model.__name__}') from error


async def _handshake(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter, hello: ChannelHello, key: bytes
) -> None:
    writer.write(encode_frame(KIND_HANDSHAKE, dumps(hello.model_dump(mode='json'))))
    challenge = _check(ChannelChallenge, await _read_handshake(reader))
    expected = mac(key, 'server', hello.role, hello.nonce, challenge.nonce)
    if not hmac.compare_digest(b64url_decode(challenge.proof), expected):
        raise ChannelError('auth-failed', '服务端未能证明持有会话密钥，地址可能被抢注')
    proof = b64url(mac(key, 'client', hello.role, hello.nonce, challenge.nonce))
    writer.write(encode_frame(KIND_HANDSHAKE, dumps({'v': 1, 'type': 'proof', 'proof': proof})))
    _check(ChannelAccept, await _read_handshake(reader))


async def _read_handshake(reader: asyncio.StreamReader) -> object:
    kind, payload = await read_frame(reader, HANDSHAKE_MAX_FRAME_BYTES)
    if kind != KIND_HANDSHAKE:
        raise ChannelError('protocol-error', '认证完成前收到业务数据')
    try:
        return json.loads(payload)
    except ValueError as error:
        raise ChannelError('protocol-error', '握手消息不是合法 JSON') from error
