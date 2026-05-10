from __future__ import annotations

from bellis import DanmakuEvent, GiftEvent, LiveEvent
from bellis_gui.adapters.base import BaseAdapter
from bellis_gui.adapters.models import SOURCE_COLORS, GUIEvent


class EventAdapter(BaseAdapter[GUIEvent]):
    def __init__(self, event_bus: object, maxsize: int = 200) -> None:
        super().__init__(maxsize=maxsize)
        self._event_bus = event_bus

    def _convert(self, event: LiveEvent) -> GUIEvent:
        user_name = ""
        if isinstance(event, DanmakuEvent):
            user_name = event.user_name
        elif isinstance(event, GiftEvent):
            user_name = event.user_name

        color_tag = SOURCE_COLORS.get(event.source, "system-color")

        return GUIEvent(
            display_text=event.content,
            source=event.source,
            color_tag=color_tag,
            user_name=user_name,
            timestamp=event.timestamp,
            priority_name=event.priority.name,
            metadata=event.metadata,
        )

    async def _run(self) -> None:
        from bellis.input.bus import EventBus

        bus: EventBus = self._event_bus
        async for event in bus.subscribe():
            if not self._running:
                break
            gui_event = self._convert(event)
            self._push(gui_event)
