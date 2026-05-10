from __future__ import annotations

from typing import Any

from textual.widgets import Static

from bellis_gui.adapters.base import BaseAdapter


class BellisWidget(Static):
    DEFAULT_CSS = """
    BellisWidget {
        background: $surface;
        border: round $primary;
        padding: 1;
        margin: 0 1;
    }
    """

    def __init__(
        self,
        *children: Any,
        name: str | None = None,
        id: str | None = None,
        classes: str | None = None,
    ) -> None:
        super().__init__(*children, name=name, id=id, classes=classes)
        self._adapters: list[BaseAdapter] = []

    def bind_adapter(self, adapter: BaseAdapter) -> None:
        self._adapters.append(adapter)

    async def start_adapters(self) -> None:
        for adapter in self._adapters:
            if not adapter.running:
                await adapter.start()

    async def stop_adapters(self) -> None:
        for adapter in self._adapters:
            if adapter.running:
                await adapter.stop()

    async def on_unmount(self) -> None:
        await self.stop_adapters()
