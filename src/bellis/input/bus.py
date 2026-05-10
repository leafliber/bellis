from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from bellis.core.enums import EventPriority
from bellis.core.events import LiveEvent
from bellis.input.sampling import SamplingStrategy, TokenBucketStrategy


class EventBus:
    def __init__(
        self,
        maxsize: int = 1000,
        sampling: SamplingStrategy | None = None,
    ) -> None:
        self._queue: asyncio.PriorityQueue[tuple[int, float, LiveEvent]] = asyncio.PriorityQueue(
            maxsize=maxsize
        )
        self._maxsize = maxsize
        self._sampling = sampling or TokenBucketStrategy()
        self._counter = 0.0

    @property
    def queue_size(self) -> int:
        return self._queue.qsize()

    async def publish(self, event: LiveEvent) -> None:
        if event.priority.value >= EventPriority.NORMAL.value:
            should_keep = await self._sampling.should_keep(event)
            if not should_keep:
                return

        self._counter += 1
        item = (event.priority.value, self._counter, event)

        try:
            self._queue.put_nowait(item)
        except asyncio.QueueFull:
            dropped = self._try_drop_low_priority()
            if dropped:
                self._queue.put_nowait(item)

    def _try_drop_low_priority(self) -> bool:
        temp: list[tuple[int, float, LiveEvent]] = []
        lowest: tuple[int, float, LiveEvent] | None = None

        while not self._queue.empty():
            try:
                item = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if lowest is None or item[0] > lowest[0]:
                if lowest is not None:
                    temp.append(lowest)
                lowest = item
            else:
                temp.append(item)

        for item in temp:
            try:
                self._queue.put_nowait(item)
            except asyncio.QueueFull:
                pass

        return lowest is not None and lowest[0] >= EventPriority.NORMAL.value

    async def subscribe(self) -> AsyncIterator[LiveEvent]:
        while True:
            _, _, event = await self._queue.get()
            yield event
            self._queue.task_done()

    async def flush(self) -> None:
        while not self._queue.empty():
            try:
                self._queue.get_nowait()
                self._queue.task_done()
            except asyncio.QueueEmpty:
                break
