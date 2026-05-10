import asyncio
from abc import ABC, abstractmethod


class BaseAdapter[T](ABC):
    def __init__(self, maxsize: int = 200) -> None:
        self._queue: asyncio.Queue[T] = asyncio.Queue(maxsize=maxsize)
        self._running = False
        self._task: asyncio.Task | None = None

    @property
    def running(self) -> bool:
        return self._running

    @property
    def queue_size(self) -> int:
        return self._queue.qsize()

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._running = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def get(self) -> T:
        return await self._queue.get()

    def get_nowait(self) -> T | None:
        try:
            return self._queue.get_nowait()
        except asyncio.QueueEmpty:
            return None

    def _push(self, item: T) -> None:
        try:
            self._queue.put_nowait(item)
        except asyncio.QueueFull:
            try:
                self._queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            self._queue.put_nowait(item)

    @abstractmethod
    async def _run(self) -> None: ...
