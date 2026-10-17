import asyncio
import struct
from collections.abc import Awaitable, Callable

from bellis_sidecar.channel import KIND_BINARY, connect
from bellis_sidecar.rpc import INVALID_PARAMS, RpcPeer
from bellis_sidecar.testing import HostSide, fake_host
from tts_local.__main__ import build_backend, parse_args
from tts_local.fake import FakeBackend, FakeConfig
from tts_local.qwen import QwenBackend
from tts_local.service import TTS_NOT_READY, TtsService

KEY = bytes([3]) * 32
Body = Callable[[HostSide, TtsService], Awaitable[None]]


def run(config: FakeConfig, body: Body) -> None:
    async def main() -> None:
        async with fake_host(KEY) as (path, accepted):
            peer = RpcPeer(await connect(path, 'sidecar.tts-local', KEY))
            service = TtsService(peer, FakeBackend(config))
            host = await accepted.get()
            try:
                await body(host, service)
            finally:
                await peer.close()
                await host.close()

    asyncio.run(main())


def synthesize(request_id: int, stream: int, text: str) -> dict[str, object]:
    return {
        'jsonrpc': '2.0',
        'id': request_id,
        'method': 'tts.synthesize',
        'params': {'stream': stream, 'text': text},
    }


def test_loads_in_background_then_streams_tagged_audio_and_words():
    async def body(host: HostSide, service: TtsService) -> None:
        # 握手时模型还在加载：状态是 loading，合成被拒绝。
        info = await host.request(1, 'tts.info')
        assert info['result'] == {
            'backend': 'fake',
            'processes': [],
            'status': {'state': 'loading', 'detail': '模型加载中'},
        }
        refused = await host.request(2, 'tts.synthesize', {'stream': 1, 'text': '你好'})
        assert refused['error']['code'] == TTS_NOT_READY
        # 加载完成后发 tts.status 通知。
        status = await host.receive_json()
        assert status == {
            'jsonrpc': '2.0',
            'method': 'tts.status',
            'params': {'state': 'ready', 'sampleRate': 16_000},
        }

        host.send(synthesize(3, 7, '你好'))
        pcm = 0
        while True:
            kind, value = await host.receive()
            if kind != KIND_BINARY:
                break
            assert struct.unpack('>I', value[:4]) == (7,)
            pcm += len(value) - 4
        assert pcm == 160
        # 时间戳在应答之前，应答即流结束。
        assert value == {
            'jsonrpc': '2.0',
            'method': 'tts.words',
            'params': {
                'stream': 7,
                'words': [
                    {'text': '你', 'startMs': 0.0, 'endMs': 2.5},
                    {'text': '好', 'startMs': 2.5, 'endMs': 5.0},
                ],
            },
        }
        assert await host.receive_json() == {'jsonrpc': '2.0', 'id': 3, 'result': {'samples': 80}}

        bad = await host.request(4, 'tts.synthesize', {'stream': '7', 'text': '你好'})
        assert bad['error']['code'] == INVALID_PARAMS
        empty = await host.request(5, 'tts.synthesize', {'stream': 1, 'text': ''})
        assert empty['error']['code'] == INVALID_PARAMS
        assert service.status.state.value == 'ready'

    config = FakeConfig(
        sample_rate=16_000, samples_per_char=40, chunk_samples=30, load_delay=0.2, aligned=True
    )
    run(config, body)


def test_load_failure_is_reported_and_final():
    async def body(host: HostSide, service: TtsService) -> None:
        status = await host.receive_json()
        assert status['params'] == {'state': 'failed', 'detail': '模型加载失败：显存不足'}
        info = await host.request(1, 'tts.info')
        assert info['result']['status']['state'] == 'failed'
        refused = await host.request(2, 'tts.synthesize', {'stream': 1, 'text': '你好'})
        assert refused['error'] == {'code': TTS_NOT_READY, 'message': '模型加载失败：显存不足'}
        await service.loaded

    run(FakeConfig(load_error='显存不足'), body)


def test_cancel_stops_the_stream():
    async def body(host: HostSide, service: TtsService) -> None:
        await service.loaded
        await host.receive_json()  # tts.status：ready
        host.send(synthesize(1, 1, '一句很长的话'))
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

    run(FakeConfig(samples_per_char=100, chunk_samples=10, chunk_delay=0.01), body)


def test_command_line_selects_the_backend():
    args = parse_args(
        ['--backend', 'fake', '--crash-on', '崩', '--crash-on', '坏', '--first-chunk-delay-ms', '5']
    )
    assert args.crash_on == ['崩', '坏']
    assert args.first_chunk_delay_ms == 5
    assert isinstance(build_backend(args), FakeBackend)
    qwen = build_backend(
        parse_args(['--backend', 'qwen3', '--model', 'Qwen/x', '--speaker', 'vivian'])
    )
    # 构造真实后端不加载模型，也不导入 torch：加载在后台线程里进行。
    assert isinstance(qwen, QwenBackend)
    assert qwen.config.speaker == 'vivian'
    assert qwen.processes() == []
