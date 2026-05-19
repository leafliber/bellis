from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from bellis.core.events import GiftEvent, LiveEvent
from bellis.input.bus import EventBus
from bellis.input.collectors.base import BaseCollector
from bellis.plugins.base import InputPlugin


class GiftCollector(BaseCollector, InputPlugin):
    """礼物事件收集器，同时实现 BaseCollector 和 InputPlugin 接口。"""

    def __init__(self, bus: EventBus) -> None:
        BaseCollector.__init__(self, bus)
        self._running = False
        self._event_queue: asyncio.Queue[LiveEvent] = asyncio.Queue()

    async def start(self) -> None:
        self._running = True

    async def stop(self) -> None:
        self._running = False

    async def listen(self) -> AsyncIterator[LiveEvent]:
        """InputPlugin 接口：产生事件流。"""
        while self._running:
            event = await self._event_queue.get()
            yield event

    async def on_gift_callback(self, raw_data: dict) -> None:
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
