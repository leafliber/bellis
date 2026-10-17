"""合成后端的接口：服务只依赖它，后端可替换。"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Stamp:
    """一个字或词的时间戳：相对这一句音频开头的毫秒。"""

    text: str
    start_ms: float
    end_ms: float


@dataclass(frozen=True)
class Loaded:
    """模型加载完成：输出 PCM 的采样率，以及给操作员看的说明（例如强制对齐不可用）。"""

    sample_rate: int
    detail: str | None = None


class Backend(Protocol):
    @property
    def name(self) -> str:
        """后端名，写进 `tts.info`，例如 `fake`、`qwen3`。"""
        ...

    def processes(self) -> list[int]:
        """后端派生的辅助进程（诊断用）。"""
        ...

    def load(self) -> Loaded:
        """加载模型（阻塞，在线程里运行）。失败时抛出异常，原因写进状态。"""
        ...

    def synthesize(self, text: str) -> AsyncGenerator[bytes]:
        """加载完成后可用：按到达顺序产出 16 位小端单声道 PCM 块（字节数为偶数）。

        被取消时生成器被关闭，后端须尽快停止产出。
        """
        ...

    async def align(self, text: str, pcm: bytes) -> list[Stamp] | None:
        """对这一句已合成的音频做强制对齐；后端不支持对齐时返回 None。"""
        ...

    def close(self) -> None:
        """进程退出前收尾：停止辅助进程。"""
        ...
