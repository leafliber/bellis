"""合成后端的接口：服务只依赖它，后端可替换。"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from typing import Protocol


class Backend(Protocol):
    @property
    def name(self) -> str:
        """后端名，写进 `tts.info`，例如 `fake`。"""
        ...

    @property
    def sample_rate(self) -> int:
        """输出 PCM 的采样率；单声道、16 位有符号小端。"""
        ...

    def processes(self) -> list[int]:
        """后端派生的辅助进程（诊断用）。"""
        ...

    def synthesize(self, text: str) -> AsyncGenerator[bytes]:
        """按到达顺序产出 PCM 块（字节数为偶数）。被取消时生成器被关闭，后端须停止生成。"""
        ...

    def close(self) -> None:
        """进程退出前收尾：停止辅助进程。"""
        ...
