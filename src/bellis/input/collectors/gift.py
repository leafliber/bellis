from __future__ import annotations

from bellis.core.events import GiftEvent
from bellis.input.bus import EventBus
from bellis.input.collectors.base import BaseCollector


class GiftCollector(BaseCollector):
    def __init__(self, bus: EventBus) -> None:
        super().__init__(bus)

    async def start(self) -> None:
        pass

    async def stop(self) -> None:
        pass

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
