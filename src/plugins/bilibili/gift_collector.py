"""礼物事件收集器 — 接收 B站直播礼物回调。"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from bellis.core.events import GiftEvent, LiveEvent
from bellis.plugin.base import InputPlugin, PluginCategory, PluginMeta
from bellis.runtime.bus import EventBus


class GiftCollector(InputPlugin):
    """礼物事件收集器，接收 B站直播礼物回调。"""

    plugin_meta = PluginMeta(
        name="bilibili_gift",
        version="0.1.0",
        description="礼物事件收集器，接收 B站直播礼物回调",
        category=PluginCategory.INPUT,
        tags=("bilibili", "gift"),
    )

    def __init__(self, bus: EventBus) -> None:
        super().__init__()
        self._bus = bus
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
        event = GiftEvent(
            content=raw_data.get("content", ""),
            user_id=raw_data.get("user_id", ""),
            user_name=raw_data.get("user_name", ""),
            gift_name=raw_data.get("gift_name", ""),
            gift_count=raw_data.get("gift_count", 1),
            coin_value=raw_data.get("coin_value", 0),
            metadata=raw_data.get("metadata", {}),
        )
        await self._bus.publish(event)
        await self._event_queue.put(event)
