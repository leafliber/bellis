import asyncio
import json
import secrets
from collections.abc import Awaitable, Callable

import pytest

from bellis_sidecar.channel import (
    HANDSHAKE_MAX_FRAME_BYTES,
    KIND_BINARY,
    KIND_HANDSHAKE,
    KIND_JSON,
    ChannelError,
    b64url,
    connect,
    decode_session_key,
    dumps,
    encode_frame,
    mac,
    read_frame,
)
from bellis_sidecar.testing import fake_host

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


def test_handshake_then_json_and_binary_frames():
    async def run() -> None:
        async with fake_host(KEY) as (path, accepted):
            connection = await connect(path, 'sidecar.tts-local', KEY)
            host = await accepted.get()
            assert host.role == 'sidecar.tts-local'
            connection.send({'data': '中文'})
            connection.send_binary(b'\x01\x02')
            await connection.drain()
            assert await host.receive() == (KIND_JSON, {'data': '中文'})
            assert await host.receive() == (KIND_BINARY, b'\x01\x02')
            host.send({'reply': True})
            assert await connection.receive() == (KIND_JSON, {'reply': True})
            # 认证后再收到握手帧即为协议错误。
            host.send_raw(KIND_HANDSHAKE, b'{}')
            with pytest.raises(ChannelError) as caught:
                await connection.receive()
            assert caught.value.code == 'protocol-error'
            await connection.close()
            await host.close()

    asyncio.run(run())


async def serve(handler: Handler, client: Callable[[str], Awaitable[None]]) -> None:
    server = await asyncio.start_server(handler, '127.0.0.1', 0)
    port = server.sockets[0].getsockname()[1]
    try:
        await client(f'tcp:127.0.0.1:{port}')
    finally:
        server.close()
        await server.wait_closed()


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


def test_malformed_challenge_and_early_business_data_are_rejected():
    async def extra_field(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await read_frame(reader, HANDSHAKE_MAX_FRAME_BYTES)
        nonce = b64url(secrets.token_bytes(32))
        challenge = {'v': 1, 'type': 'challenge', 'nonce': nonce, 'proof': nonce, 'x': 1}
        writer.write(encode_frame(KIND_HANDSHAKE, dumps(challenge)))
        await reader.read()
        writer.close()

    async def eager(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await read_frame(reader, HANDSHAKE_MAX_FRAME_BYTES)
        writer.write(encode_frame(KIND_JSON, b'{}'))
        await reader.read()
        writer.close()

    async def client(path: str) -> None:
        with pytest.raises(ChannelError) as caught:
            await connect(path, 'sidecar.probe', KEY)
        assert caught.value.code == 'protocol-error'

    asyncio.run(serve(extra_field, client))
    asyncio.run(serve(eager, client))


def test_invalid_role_is_rejected_before_connecting():
    async def run() -> None:
        with pytest.raises(ChannelError) as caught:
            await connect('tcp:127.0.0.1:1', 'Sidecar.Upper', KEY)
        assert caught.value.code == 'protocol-error'

    asyncio.run(run())


def test_hello_matches_node_format():
    async def run() -> None:
        seen: list[dict[str, object]] = []

        async def capture(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            _, payload = await read_frame(reader, HANDSHAKE_MAX_FRAME_BYTES)
            seen.append(json.loads(payload))
            writer.close()

        async def client(path: str) -> None:
            with pytest.raises(ChannelError):
                await connect(path, 'sidecar.probe', KEY)

        await serve(capture, client)
        assert list(seen[0]) == ['v', 'type', 'role', 'nonce']
        assert seen[0]['role'] == 'sidecar.probe'

    asyncio.run(run())
