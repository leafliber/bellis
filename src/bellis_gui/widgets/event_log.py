from __future__ import annotations

from textual.containers import VerticalScroll
from textual.widgets import Static

from bellis_gui.adapters.event_adapter import EventAdapter
from bellis_gui.adapters.models import GUIEvent
from bellis_gui.widgets.base import BellisWidget


class EventItem(Static):
    DEFAULT_CSS = """
    EventItem {
        padding: 0 1;
        margin: 0;
        height: auto;
    }
    EventItem.danmaku { color: $danmaku-color; }
    EventItem.gift { color: $gift-color; }
    EventItem.command { color: $command-color; }
    EventItem.system { color: $system-color; }
    """

    def __init__(self, event: GUIEvent) -> None:
        time_str = event.timestamp.strftime("%H:%M:%S")
        user_part = f"[{event.user_name}] " if event.user_name else ""
        text = f"{time_str} [{event.source.value}] {user_part}{event.display_text}"
        super().__init__(text)
        self.add_class(event.source.value)


class EventLog(BellisWidget):
    DEFAULT_CSS = """
    EventLog {
        height: 1fr;
        width: 1fr;
        overflow-y: auto;
    }
    EventLog VerticalScroll {
        height: auto;
    }
    """

    def __init__(self, event_adapter: EventAdapter | None = None, **kwargs) -> None:
        super().__init__(**kwargs)
        self._event_adapter = event_adapter
        self._max_items = 200
        self._item_count = 0

    def compose(self):
        self._scroll = VerticalScroll(id="event-scroll")
        yield self._scroll

    async def on_mount(self) -> None:
        if self._event_adapter is not None:
            self.bind_adapter(self._event_adapter)
            await self.start_adapters()
            self.set_interval(0.1, self._poll_events)

    def _poll_events(self) -> None:
        if self._event_adapter is None:
            return
        while True:
            event = self._event_adapter.get_nowait()
            if event is None:
                break
            self._add_event(event)

    def _add_event(self, event: GUIEvent) -> None:
        item = EventItem(event)
        scroll = self.query_one("#event-scroll", VerticalScroll)
        scroll.mount(item)
        self._item_count += 1
        if self._item_count > self._max_items:
            children = scroll.children
            if children:
                children[0].remove()
                self._item_count -= 1
        scroll.scroll_end(animate=False)

    def add_event(self, event: GUIEvent) -> None:
        self._add_event(event)
