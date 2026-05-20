"""Bilibili WebSocket 公共基类 — 消除弹幕/命令收集器的重复代码。"""

from __future__ import annotations

import asyncio
import logging
from abc import abstractmethod
from collections.abc import AsyncIterator

import websockets

from bellis.core.events import LiveEvent
from bellis.plugin.base import InputPlugin

logger = logging.getLogger(__name__)


class BilibiliWSInputPlugin(InputPlugin):
    """B站 WebSocket 输入插件基类，封装连接/重连/消息解析逻辑。

    子类只需实现：
    1. ``plugin_meta`` — 插件元数据
    2. ``_parse_message()`` — 将原始 JSON 字符串解析为 LiveEvent
    """

    def __init__(self, uri: str) -> None:
        """初始化 WebSocket 输入插件。

        Args:
            uri: WebSocket 服务端地址，例如 ``ws://localhost:8080/danmaku``。
        """
        super().__init__()
        self._uri = uri
        self._ws = None
        self._task: asyncio.Task[None] | None = None
        self._event_queue: asyncio.Queue[LiveEvent] = asyncio.Queue()

    async def _on_start(self) -> None:
        """插件启动时创建后台消费协程。"""
        self._task = asyncio.create_task(self._consume_loop())

    async def _on_stop(self) -> None:
        """插件停止时关闭 WebSocket 连接并取消消费协程。"""
        if self._ws is not None:
            await self._ws.close()
            self._ws = None
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def listen(self) -> AsyncIterator[LiveEvent]:
        """从事件队列中持续读取并产出 LiveEvent。

        Yields:
            LiveEvent: 从 WebSocket 消息解析得到的事件。
        """
        while self.state.value == "running":
            event = await self._event_queue.get()
            yield event

    async def _consume_loop(self) -> None:
        """WebSocket 消费主循环，包含指数退避重连逻辑。

        连接断开或异常时，以指数退避策略自动重连，
        初始延迟 1 秒，最大延迟 30 秒，每次重连成功后重置延迟。
        """
        retry_delay = 1.0
        max_retry_delay = 30.0
        while self.state.value in ("starting", "running"):
            try:
                async with websockets.connect(self._uri) as ws:
                    self._ws = ws
                    logger.info("%s WebSocket 已连接: %s", self.name, self._uri)
                    retry_delay = 1.0  # 连接成功，重置退避延迟
                    async for message in ws:
                        if self.state.value not in ("starting", "running"):
                            break
                        event = self._parse_message(message)
                        if event is not None:
                            await self._event_queue.put(event)
            except asyncio.CancelledError:
                break
            except Exception:
                if self.state.value in ("starting", "running"):
                    logger.warning("%s WebSocket 连接异常，%0.1f 秒后重试", self.name, retry_delay)
                    await asyncio.sleep(retry_delay)
                    retry_delay = min(retry_delay * 2, max_retry_delay)  # 指数退避，上限 30 秒

    @abstractmethod
    def _parse_message(self, raw: str) -> LiveEvent | None:
        """将原始 JSON 字符串解析为 LiveEvent，解析失败返回 None。"""
