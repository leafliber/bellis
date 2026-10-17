import asyncio
import contextlib
import math
import sys
from array import array
from typing import NoReturn

import pytest

from tts_local.backend import Loaded, Stamp
from tts_local.fake import TONE_AMPLITUDE, FakeBackend, FakeConfig


def test_load_and_align_simulate_a_model():
    backend = FakeBackend(FakeConfig(sample_rate=8000, samples_per_char=80, aligned=True))
    assert backend.load() == Loaded(8000)
    stamps = asyncio.run(backend.align('你 好', b''))
    assert stamps == [Stamp('你', 0.0, 10.0), Stamp('好', 20.0, 30.0)]
    assert asyncio.run(FakeBackend(FakeConfig()).align('你好', b'')) is None
    with pytest.raises(RuntimeError, match='显存不足'):
        FakeBackend(FakeConfig(load_error='显存不足')).load()


class Crashed(Exception):
    pass


def crash() -> NoReturn:
    raise Crashed


async def collect(backend: FakeBackend, text: str) -> list[bytes]:
    return [chunk async for chunk in backend.synthesize(text)]


def test_length_follows_code_points_and_chunks():
    backend = FakeBackend(FakeConfig(samples_per_char=100, chunk_samples=60))
    chunks = asyncio.run(collect(backend, '你好😀'))
    assert sum(len(chunk) for chunk in chunks) == 2 * 300
    assert [len(chunk) // 2 for chunk in chunks] == [60, 60, 60, 60, 60]
    assert all(chunk == bytes(len(chunk)) for chunk in chunks)
    assert backend.processes() == []
    assert backend.sample_rate == 24_000


def test_tone_is_a_sine_at_the_given_frequency():
    config = FakeConfig(sample_rate=8000, samples_per_char=800, chunk_samples=800, tone_hz=1000)
    chunks = asyncio.run(collect(FakeBackend(config), '音'))
    samples = array('h')
    samples.frombytes(chunks[0])
    if sys.byteorder == 'big':
        samples.byteswap()
    # 1000Hz、8000 采样率：每 8 个采样一个周期；第 2 个采样在波峰。
    assert samples[2] == round(TONE_AMPLITUDE * math.sin(math.pi / 2))
    assert samples[0] == 0
    assert max(samples) <= TONE_AMPLITUDE


def test_crash_after_half_of_the_audio():
    config = FakeConfig(samples_per_char=100, chunk_samples=50, crash_on=('崩',))
    backend = FakeBackend(config, crash=crash)
    sent: list[bytes] = []

    async def run() -> None:
        async for chunk in backend.synthesize('会崩'):
            sent.append(chunk)

    with pytest.raises(Crashed):
        asyncio.run(run())
    assert sum(len(chunk) for chunk in sent) // 2 == 100
    # 不含触发片段的句子照常合成。
    assert len(asyncio.run(collect(backend, '正常'))) == 4


def test_cancel_stops_generation():
    config = FakeConfig(samples_per_char=100, chunk_samples=10, chunk_delay=0.01)
    backend = FakeBackend(config)
    produced: list[bytes] = []

    async def run() -> None:
        async def consume() -> None:
            async with contextlib.aclosing(backend.synthesize('很长的一句话')) as chunks:
                async for chunk in chunks:
                    produced.append(chunk)

        task = asyncio.ensure_future(consume())
        await asyncio.sleep(0.05)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        count = len(produced)
        await asyncio.sleep(0.05)
        assert len(produced) == count

    asyncio.run(run())
    assert 0 < len(produced) < 60


def test_workers_are_spawned_and_stopped():
    backend = FakeBackend(FakeConfig(workers=2))
    pids = backend.processes()
    assert len(pids) == 2
    backend.close()
    assert all(worker.poll() is not None for worker in backend._workers)  # pyright: ignore[reportPrivateUsage]
