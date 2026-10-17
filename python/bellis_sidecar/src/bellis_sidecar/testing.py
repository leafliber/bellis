"""只供测试：在 127.0.0.1 上扮演宿主（通道服务端），如实完成握手后把原始读写交给测试。

生产中宿主是 Node（`packages/channel`）；这里的握手与它逐字节一致，只用于 sidecar 一侧的单元测试。
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import secrets
from collections.abc import AsyncGenerator
from typing import Any

from .channel import (
    HANDSHAKE_MAX_FRAME_BYTES,
    KIND_BINARY,
    KIND_HANDSHAKE,
    KIND_JSON,
    b64url,
    dumps,
    encode_frame,
    mac,
    read_frame,
)


class HostSide:
    """宿主一侧的一条已认证连接。"""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, role: str):
        self.role = role
        self._reader = reader
        self._writer = writer

    def send(self, message: object) -> None:
        self._writer.write(encode_frame(KIND_JSON, dumps(message)))

    def send_raw(self, kind: int, payload: bytes) -> None:
        self._writer.write(encode_frame(kind, payload))

    async def receive(self, timeout: float = 5.0) -> tuple[int, Any]:
        """下一帧：JSON 帧返回解析后的值，二进制帧返回 bytes。"""
        async with asyncio.timeout(timeout):
            kind, payload = await read_frame(self._reader, 1024 * 1024)
        return (kind, json.loads(payload)) if kind == KIND_JSON else (kind, payload)

    async def receive_json(self, timeout: float = 5.0) -> dict[str, Any]:
        """跳过二进制帧，取下一条 JSON 消息。"""
        while True:
            kind, value = await self.receive(timeout)
            if kind != KIND_BINARY:
                return value

    async def request(self, request_id: int, method: str, params: object = None) -> Any:
        """发一个请求并等它的应答（期间的其它消息与二进制帧被丢弃）。"""
        message: dict[str, object] = {'jsonrpc': '2.0', 'id': request_id, 'method': method}
        if params is not None:
            message['params'] = params
        self.send(message)
        while True:
            reply = await self.receive_json()
            if reply.get('id') == request_id:
                return reply

    async def close(self) -> None:
        self._writer.close()
        with contextlib.suppress(OSError):
            await self._writer.wait_closed()


@contextlib.asynccontextmanager
async def fake_host(key: bytes) -> AsyncGenerator[tuple[str, asyncio.Queue[HostSide]]]:
    """启动假宿主，交出地址（`tcp:127.0.0.1:端口`）与已认证连接的队列。"""
    accepted: asyncio.Queue[HostSide] = asyncio.Queue()
    writers: list[asyncio.StreamWriter] = []

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        writers.append(writer)
        _, payload = await read_frame(reader, HANDSHAKE_MAX_FRAME_BYTES)
        hello = json.loads(payload)
        server_nonce = b64url(secrets.token_bytes(32))
        proof = b64url(mac(key, 'server', hello['role'], hello['nonce'], server_nonce))
        challenge = {'v': 1, 'type': 'challenge', 'nonce': server_nonce, 'proof': proof}
        writer.write(encode_frame(KIND_HANDSHAKE, dumps(challenge)))
        _, payload = await read_frame(reader, HANDSHAKE_MAX_FRAME_BYTES)
        expected = b64url(mac(key, 'client', hello['role'], hello['nonce'], server_nonce))
        if json.loads(payload).get('proof') != expected:
            writer.close()
            return
        writer.write(encode_frame(KIND_HANDSHAKE, dumps({'v': 1, 'type': 'accept'})))
        await accepted.put(HostSide(reader, writer, hello['role']))

    server = await asyncio.start_server(handle, '127.0.0.1', 0)
    port = server.sockets[0].getsockname()[1]
    try:
        yield f'tcp:127.0.0.1:{port}', accepted
    finally:
        server.close()
        # Python 3.12 的 wait_closed 要等全部连接关闭。
        for writer in writers:
            writer.close()
        await server.wait_closed()
