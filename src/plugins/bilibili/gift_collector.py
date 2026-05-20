"""礼物事件收集器 — 接收 B站直播礼物回调。"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator

from bellis.core.events import GiftEvent, LiveEvent
from bellis.plugin.base import InputPlugin, PluginCategory, PluginMeta

logger = logging.getLogger(__name__)


class GiftCollector(InputPlugin):
    """礼物事件收集器，接收 B站直播礼物回调。

    与弹幕/命令收集器不同，礼物事件通过外部回调接口注入，
    不走 WebSocket 通道，因此不继承 BilibiliWSInputPlugin。
    """

    plugin_meta = PluginMeta(
        name="bilibili_gift",
        version="0.1.0",
        description="礼物事件收集器，接收 B站直播礼物回调",
        category=PluginCategory.INPUT,
        tags=("bilibili", "gift"),
    )

    def __init__(self) -> None:
        super().__init__()
        self._event_queue: asyncio.Queue[LiveEvent] = asyncio.Queue()

    async def _on_start(self) -> None:
        pass

    async def _on_stop(self) -> None:
        pass

    async def listen(self) -> AsyncIterator[LiveEvent]:
        while self.state.value == "running":
            event = await self._event_queue.get()
            yield event

    async def on_gift_callback(self, raw_data: dict) -> None:
        """外部回调接口，由 bilibili-api SDK 调用。"""
        try:
            event = GiftEvent(
                content=raw_data.get("content", ""),
                user_id=raw_data.get("user_id", ""),
                user_name=raw_data.get("user_name", ""),
                gift_name=raw_data.get("gift_name", ""),
                gift_count=raw_data.get("gift_count", 1),
                coin_value=raw_data.get("coin_value", 0),
                metadata=raw_data.get("metadata", {}),
            )
            await self._event_queue.put(event)
            logger.info("收到礼物: user=%s gift=%s count=%d coin=%d",
                        event.user_name, event.gift_name, event.gift_count, event.coin_value)
        except Exception:
            logger.exception("礼物回调处理失败: %s", raw_data)
