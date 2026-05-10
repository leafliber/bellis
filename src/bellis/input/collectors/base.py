from __future__ import annotations

from abc import ABC, abstractmethod

from bellis.input.bus import EventBus


class BaseCollector(ABC):
    def __init__(self, bus: EventBus) -> None:
        self._bus = bus

    @abstractmethod
    async def start(self) -> None: ...

    @abstractmethod
    async def stop(self) -> None: ...
