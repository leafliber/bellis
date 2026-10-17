"""假后端：不加载模型，按朗读文本的码点数产生固定采样率的正弦或静音。只用于测试与演练。

- `first_chunk_delay`、`chunk_delay`：模拟首包延迟与生成速度；
- `crash_on`：朗读文本含这些片段时，送出一半音频后进程直接崩溃（不收尾，模拟原生库崩溃）；
- `workers`：启动时派生若干空转的辅助进程（模拟模型库自己起的进程），用来核对它们随 sidecar 退出。
"""

from __future__ import annotations

import asyncio
import math
import os
import subprocess
import sys
from array import array
from collections.abc import AsyncGenerator, Callable
from dataclasses import dataclass
from typing import NoReturn

from bellis_sidecar.processes import spawn, stop

#: 辅助进程只看 stdin 生命线：读到 EOF 即退出。
WORKER_CODE = 'import sys\nwhile sys.stdin.buffer.read(65536):\n    pass\n'
#: 模拟崩溃时的退出码。
CRASH_EXIT_CODE = 70
#: 正弦测试音的振幅（满幅的 0.2）。
TONE_AMPLITUDE = 6553


@dataclass(frozen=True)
class FakeConfig:
    sample_rate: int = 24_000
    samples_per_char: int = 4_800
    chunk_samples: int = 2_400
    first_chunk_delay: float = 0.0
    chunk_delay: float = 0.0
    #: 大于 0 时输出该频率的正弦测试音，否则输出静音。
    tone_hz: float = 0.0
    crash_on: tuple[str, ...] = ()
    workers: int = 0


def _crash() -> NoReturn:
    os._exit(CRASH_EXIT_CODE)


class FakeBackend:
    name = 'fake'

    def __init__(self, config: FakeConfig, *, crash: Callable[[], NoReturn] = _crash) -> None:
        if config.chunk_samples < 1 or config.samples_per_char < 1:
            raise ValueError('chunk_samples 与 samples_per_char 须为正数')
        self.config = config
        self._crash = crash
        self._workers: list[subprocess.Popen[bytes]] = [
            spawn([sys.executable, '-c', WORKER_CODE]) for _ in range(config.workers)
        ]

    @property
    def sample_rate(self) -> int:
        return self.config.sample_rate

    def processes(self) -> list[int]:
        return [worker.pid for worker in self._workers]

    async def synthesize(self, text: str) -> AsyncGenerator[bytes]:
        config = self.config
        total = len(text) * config.samples_per_char
        crash_at = total // 2 if any(part in text for part in config.crash_on) else None
        if config.first_chunk_delay > 0:
            await asyncio.sleep(config.first_chunk_delay)
        offset = 0
        while offset < total:
            if crash_at is not None and offset >= crash_at:
                # 先让已送出的音频到达宿主，再像原生库崩溃那样直接退出。
                await asyncio.sleep(0.2)
                self._crash()
            if offset > 0 and config.chunk_delay > 0:
                await asyncio.sleep(config.chunk_delay)
            count = min(config.chunk_samples, total - offset)
            yield self._pcm(offset, count)
            offset += count
            # 让出事件循环，取消能及时生效。
            await asyncio.sleep(0)

    def _pcm(self, offset: int, count: int) -> bytes:
        config = self.config
        if config.tone_hz <= 0:
            return bytes(2 * count)
        step = 2 * math.pi * config.tone_hz / config.sample_rate
        samples = array(
            'h', (round(TONE_AMPLITUDE * math.sin(step * (offset + i))) for i in range(count))
        )
        if sys.byteorder == 'big':
            samples.byteswap()
        return samples.tobytes()

    def close(self) -> None:
        for worker in self._workers:
            stop(worker)
