import asyncio
import json
import secrets
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from bellis_channel import (
    HANDSHAKE_MAX_FRAME_BYTES,
    KIND_HANDSHAKE,
    KIND_JSON,
    ChannelError,
    RpcClient,
    b64url,
    connect,
    decode_session_key,
    dumps,
    encode_frame,
    mac,
    read_frame,
)

KEY = bytes([7]) * 32
Handler = Callable[[asyncio.StreamReader, asyncio.StreamWriter], Awaitable[None]]


def test_mac_matches_node():
    # 由 Node 的 packages/channel 同一算法算出。
    proof = mac(KEY, 'server', 'sidecar.tts', 'A' * 43, 'b' * 43)
    assert b64url(proof) == 'Z49ZDFIB6fcMI6I3N5tp824wFOzf7LRKWsnHsqKf30Y'


def test_session_key_must_be_32_bytes_unpadded():
    assert decode_session_key(b64url(KEY)) == KEY
    for text in (b64url(KEY[:31]), b64url(KEY) + '=', 'not base64!'):
        with pytest.raises(ChannelError) as caught:
            decode_session_key(text)
        assert caught.value.code == 'invalid-key'


def reader_of(data: bytes) -> asyncio.StreamReader:
    reader = asyncio.StreamReader()
    reader.feed_data(data)
    reader.feed_eof()
    return reader


def test_frames_round_trip_and_reject_bad_headers():
    async def run() -> None:
        assert await read_frame(reader_of(encode_frame(KIND_JSON, b'{}')), 16) == (KIND_JSON, b'{}')
        cases = [
            (encode_frame(KIND_JSON, b'x' * 17), 'frame-too-large'),
            (b'\x00\x00\x00\x00\x09', 'protocol-error'),
            (encode_frame(KIND_JSON, b'{}')[:-1], 'closed'),
        ]
        for data, code in cases:
            with pytest.raises(ChannelError) as caught:
                await read_frame(reader_of(data), 16)
            assert caught.value.code == code

    asyncio.run(run())


async def serve(handler: Handler, client: Callable[[str], Awaitable[None]]) -> None:
    server = await asyncio.start_server(handler, '127.0.0.1', 0)
    port = server.sockets[0].getsockname()[1]
    try:
        await client(f'tcp:127.0.0.1:{port}')
    finally:
        server.close()
        await server.wait_closed()


async def read_object(reader: asyncio.StreamReader, max_payload: int) -> tuple[int, Any]:
    kind, payload = await read_frame(reader, max_payload)
    return kind, json.loads(payload)


def test_handshake_and_rpc_with_honest_server():
    async def honest(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        _, hello = await read_object(reader, HANDSHAKE_MAX_FRAME_BYTES)
        server_nonce = b64url(secrets.token_bytes(32))
        proof = b64url(mac(KEY, 'server', hello['role'], hello['nonce'], server_nonce))
        challenge = {'v': 1, 'type': 'challenge', 'nonce': server_nonce, 'proof': proof}
        writer.write(encode_frame(KIND_HANDSHAKE, dumps(challenge)))
        _, answer = await read_object(reader, HANDSHAKE_MAX_FRAME_BYTES)
        expected = b64url(mac(KEY, 'client', hello['role'], hello['nonce'], server_nonce))
        assert answer == {'v': 1, 'type': 'proof', 'proof': expected}
        writer.write(encode_frame(KIND_HANDSHAKE, dumps({'v': 1, 'type': 'accept'})))
        _, request = await read_object(reader, 1024)
        reply = {'jsonrpc': '2.0', 'id': request['id'], 'result': request['params']}
        writer.write(encode_frame(KIND_JSON, dumps(reply)))
        await writer.drain()
        writer.close()

    async def client(path: str) -> None:
        connection = await connect(path, 'sidecar.probe', KEY)
        rpc = RpcClient(connection)
        assert await rpc.request('spike.echo', {'data': '中文'}) == {'data': '中文'}
        await rpc.close()

    asyncio.run(serve(honest, client))


def test_squatter_gets_nothing_after_hello():
    received: list[bytes] = []

    async def squatter(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await read_frame(reader, HANDSHAKE_MAX_FRAME_BYTES)
        fake = b64url(secrets.token_bytes(32))
        challenge = {'v': 1, 'type': 'challenge', 'nonce': fake, 'proof': fake}
        writer.write(encode_frame(KIND_HANDSHAKE, dumps(challenge)))
        received.append(await reader.read())
        writer.close()

    async def client(path: str) -> None:
        with pytest.raises(ChannelError) as caught:
            await connect(path, 'sidecar.probe', KEY)
        assert caught.value.code == 'auth-failed'
        await asyncio.sleep(0.05)

    asyncio.run(serve(squatter, client))
    assert received == [b'']


def test_business_data_before_auth_is_rejected():
    async def eager(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await read_frame(reader, HANDSHAKE_MAX_FRAME_BYTES)
        writer.write(encode_frame(KIND_JSON, b'{}'))
        await reader.read()
        writer.close()

    async def client(path: str) -> None:
        with pytest.raises(ChannelError) as caught:
            await connect(path, 'sidecar.probe', KEY)
        assert caught.value.code == 'protocol-error'

    asyncio.run(serve(eager, client))
