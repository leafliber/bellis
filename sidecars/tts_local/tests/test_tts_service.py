import asyncio
import struct

from bellis_sidecar.channel import KIND_BINARY, connect
from bellis_sidecar.rpc import INVALID_PARAMS, RpcPeer
from bellis_sidecar.testing import fake_host
from tts_local.__main__ import parse_args
from tts_local.fake import FakeBackend, FakeConfig
from tts_local.service import register

KEY = bytes([3]) * 32


def test_info_and_synthesize_stream_tagged_audio():
    async def main() -> None:
        backend = FakeBackend(FakeConfig(sample_rate=16_000, samples_per_char=40, chunk_samples=30))
        async with fake_host(KEY) as (path, accepted):
            peer = RpcPeer(await connect(path, 'sidecar.tts-local', KEY))
            register(peer, backend)
            host = await accepted.get()

            info = await host.request(1, 'tts.info')
            assert info['result'] == {'sampleRate': 16_000, 'backend': 'fake', 'processes': []}

            host.send(
                {
                    'jsonrpc': '2.0',
                    'id': 2,
                    'method': 'tts.synthesize',
                    'params': {'stream': 7, 'text': '你好'},
                }
            )
            pcm = 0
            while True:
                kind, value = await host.receive()
                if kind != KIND_BINARY:
                    break
                assert struct.unpack('>I', value[:4]) == (7,)
                pcm += len(value) - 4
            # 应答在全部音频帧之后。
            assert value == {'jsonrpc': '2.0', 'id': 2, 'result': {'samples': 80}}
            assert pcm == 160

            bad = await host.request(3, 'tts.synthesize', {'stream': '7', 'text': '你好'})
            assert bad['error']['code'] == INVALID_PARAMS
            empty = await host.request(4, 'tts.synthesize', {'stream': 1, 'text': ''})
            assert empty['error']['code'] == INVALID_PARAMS
            await peer.close()
            await host.close()

    asyncio.run(main())


def test_cancel_stops_the_stream():
    async def main() -> None:
        config = FakeConfig(samples_per_char=100, chunk_samples=10, chunk_delay=0.01)
        async with fake_host(KEY) as (path, accepted):
            peer = RpcPeer(await connect(path, 'sidecar.tts-local', KEY))
            register(peer, FakeBackend(config))
            host = await accepted.get()
            params = {'stream': 1, 'text': '一句很长的话'}
            host.send({'jsonrpc': '2.0', 'id': 1, 'method': 'tts.synthesize', 'params': params})
            kind, _ = await host.receive()
            assert kind == KIND_BINARY
            host.send({'jsonrpc': '2.0', 'method': 'rpc.cancel', 'params': {'id': 1}})
            frames = 1
            while True:
                kind, value = await host.receive()
                if kind != KIND_BINARY:
                    break
                frames += 1
            assert value['error']['message'] == 'Request cancelled'
            assert frames < 60
            await peer.close()
            await host.close()

    asyncio.run(main())


def test_command_line_maps_to_fake_config():
    args = parse_args(
        ['--backend', 'fake', '--crash-on', '崩', '--crash-on', '坏', '--first-chunk-delay-ms', '5']
    )
    assert args.crash_on == ['崩', '坏']
    assert args.first_chunk_delay_ms == 5
