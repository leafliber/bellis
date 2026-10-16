"""本机通道的 Python 客户端（D-12、R-05），与 `packages/channel` 逐字节兼容。

帧：4 字节大端负载长度 + 1 字节类型（0 握手、1 JSON、2 二进制）+ 负载。
握手：客户端发 hello；服务端回 challenge，先证明持有会话密钥；
客户端核验后回 proof；服务端回 accept。
证明为 HMAC-SHA256(会话密钥, JSON([域, 方向, 角色, 客户端随机数, 服务端随机数]))，base64url 无填充。
服务端未能证明时立即断开，不回送证明，也不发任何业务数据（地址可能被抢注）。

探针 S-03 先在 spikes 里验证这一实现；sidecar 正式落地时再按第 6 步迁移。
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import hmac
import json
import re
import secrets
import struct
import sys
from typing import Any, cast

PROOF_DOMAIN = 'bellis-channel/1'
SESSION_KEY_BYTES = 32
KEY_ENV = 'BELLIS_CHANNEL_KEY'

KIND_HANDSHAKE = 0
KIND_JSON = 1
KIND_BINARY = 2
_KINDS = (KIND_HANDSHAKE, KIND_JSON, KIND_BINARY)
_HEADER = struct.Struct('>IB')

HANDSHAKE_MAX_FRAME_BYTES = 1024
DEFAULT_MAX_FRAME_BYTES = 1024 * 1024
DEFAULT_HANDSHAKE_TIMEOUT = 2.0

ROLE = re.compile(r'[a-z][a-z0-9_.:-]{0,63}')
BYTES32 = re.compile(r'[A-Za-z0-9_-]{43}')
TCP_PREFIX = 'tcp:'


class ChannelError(Exception):
    """与 Node 侧 ChannelError 的错误码一致，例如 `auth-failed`、`protocol-error`。"""

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
    record = json.dumps(
        [PROOF_DOMAIN, direction, role, client_nonce, server_nonce],
        separators=(',', ':'),
        ensure_ascii=False,
    )
    return hmac.new(key, record.encode('utf-8'), hashlib.sha256).digest()


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


def dumps(message: object) -> bytes:
    """紧凑 UTF-8 JSON，与 Node 的 `JSON.stringify` 输出一致。"""
    return json.dumps(message, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def _object(payload: bytes) -> dict[str, Any]:
    try:
        message: Any = json.loads(payload)
    except ValueError as error:
        raise ChannelError('protocol-error', '握手消息不是合法 JSON') from error
    if not isinstance(message, dict):
        raise ChannelError('protocol-error', '握手消息不是对象')
    return cast(dict[str, Any], message)


def _check_message(message: dict[str, Any], kind: str, fields: dict[str, re.Pattern[str]]) -> None:
    """与服务端的 TypeBox 定义同样严格：字段集合固定，值须匹配格式。"""
    if set(message) != {'v', 'type', *fields} or message['v'] != 1 or message['type'] != kind:
        raise ChannelError('protocol-error', f'握手消息不合法，期望 {kind}')
    for name, pattern in fields.items():
        value = message[name]
        if not isinstance(value, str) or pattern.fullmatch(value) is None:
            raise ChannelError('protocol-error', f'握手消息不合法，期望 {kind}')


async def open_stream(path: str) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    """按地址打开字节流：`tcp:主机:端口` 只供探针对比，其余为命名管道（Windows）或 UDS。"""
    if path.startswith(TCP_PREFIX):
        host, _, port = path.removeprefix(TCP_PREFIX).rpartition(':')
        return await asyncio.open_connection(host, int(port))
    if sys.platform == 'win32':
        loop = asyncio.get_running_loop()
        if not isinstance(loop, asyncio.ProactorEventLoop):
            raise ChannelError('connect-failed', '命名管道需要 ProactorEventLoop')
        reader = asyncio.StreamReader(limit=DEFAULT_MAX_FRAME_BYTES)
        protocol = asyncio.StreamReaderProtocol(reader)
        transport, _ = await loop.create_pipe_connection(lambda: protocol, path)
        return reader, asyncio.StreamWriter(transport, protocol, reader, loop)
    return await asyncio.open_unix_connection(path)


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

    def send(self, message: object) -> None:
        self._write(KIND_JSON, dumps(message))

    def send_binary(self, data: bytes) -> None:
        self._write(KIND_BINARY, data)

    async def drain(self) -> None:
        await self._writer.drain()

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
        self._writer.close()
        with contextlib.suppress(OSError):
            await self._writer.wait_closed()

    def _write(self, kind: int, payload: bytes) -> None:
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
    if ROLE.fullmatch(role) is None:
        raise ChannelError('protocol-error', f'角色名不合法：{role}')
    try:
        reader, writer = await open_stream(path)
    except OSError as error:
        raise ChannelError('connect-failed', f'无法连接通道：{error}') from error
    try:
        async with asyncio.timeout(handshake_timeout):
            await _handshake(reader, writer, role, key)
    except TimeoutError as error:
        writer.close()
        raise ChannelError('handshake-timeout', f'握手未在 {handshake_timeout}s 内完成') from error
    except BaseException:
        writer.close()
        raise
    return Connection(reader, writer, role, max_frame_bytes)


async def _handshake(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter, role: str, key: bytes
) -> None:
    client_nonce = b64url(secrets.token_bytes(32))
    hello = {'v': 1, 'type': 'hello', 'role': role, 'nonce': client_nonce}
    writer.write(encode_frame(KIND_HANDSHAKE, dumps(hello)))

    challenge = await _read_handshake(reader)
    _check_message(challenge, 'challenge', {'nonce': BYTES32, 'proof': BYTES32})
    server_nonce: str = challenge['nonce']
    expected = mac(key, 'server', role, client_nonce, server_nonce)
    if not hmac.compare_digest(b64url_decode(challenge['proof']), expected):
        raise ChannelError('auth-failed', '服务端未能证明持有会话密钥，地址可能被抢注')

    proof = b64url(mac(key, 'client', role, client_nonce, server_nonce))
    writer.write(encode_frame(KIND_HANDSHAKE, dumps({'v': 1, 'type': 'proof', 'proof': proof})))
    _check_message(await _read_handshake(reader), 'accept', {})


async def _read_handshake(reader: asyncio.StreamReader) -> dict[str, Any]:
    kind, payload = await read_frame(reader, HANDSHAKE_MAX_FRAME_BYTES)
    if kind != KIND_HANDSHAKE:
        raise ChannelError('protocol-error', '认证完成前收到业务数据')
    return _object(payload)


class RpcError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


class RpcClient:
    """连接之上最小的 JSON-RPC 2.0 请求方：按 id 配对响应。探针只需要请求，不处理对端请求。"""

    def __init__(self, connection: Connection) -> None:
        self._connection = connection
        self._next_id = 1
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._reader = asyncio.create_task(self._read())

    async def request(self, method: str, params: object = None) -> Any:
        request_id = self._next_id
        self._next_id += 1
        message: dict[str, object] = {'jsonrpc': '2.0', 'id': request_id, 'method': method}
        if params is not None:
            message['params'] = params
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        self._connection.send(message)
        try:
            return await future
        finally:
            self._pending.pop(request_id, None)

    async def close(self) -> None:
        self._reader.cancel()
        await self._connection.close()

    async def _read(self) -> None:
        try:
            while True:
                kind, message = await self._connection.receive()
                if kind != KIND_JSON or not isinstance(message, dict):
                    continue
                reply = cast(dict[str, Any], message)
                future = self._pending.get(reply.get('id', 0))
                if future is None or future.done():
                    continue
                if 'error' in reply:
                    failure: dict[str, Any] = reply['error']
                    future.set_exception(RpcError(failure['code'], failure['message']))
                else:
                    future.set_result(reply.get('result'))
        except ChannelError as error:
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(error)
