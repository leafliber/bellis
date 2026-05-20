"""事件总线模块。

提供基于优先级队列的异步事件发布/订阅机制，
支持采样策略过滤和低优先级事件淘汰。
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator

from bellis.core.enums import EventPriority
from bellis.core.events import LiveEvent
from bellis.runtime.sampling import SamplingStrategy, TokenBucketStrategy

logger = logging.getLogger(__name__)


class EventBus:
    """异步优先级事件总线，负责事件的发布、采样与分发。

    内部使用 asyncio.PriorityQueue 存储事件，元组格式为
    (priority_value, counter, event)，其中 counter 用于保证
    同优先级事件的 FIFO 顺序。

    Attributes:
        queue_size: 当前队列中的事件数量。
    """

    def __init__(
        self,
        maxsize: int = 1000,
        sampling: SamplingStrategy | None = None,
    ) -> None:
        """初始化事件总线。

        Args:
            maxsize: 优先级队列最大容量。
            sampling: 采样策略实例，为 None 时使用 TokenBucketStrategy。
        """
        self._queue: asyncio.PriorityQueue[tuple[int, int, LiveEvent]] = asyncio.PriorityQueue(maxsize=maxsize)
        self._maxsize = maxsize
        self._sampling = sampling or TokenBucketStrategy()
        self._counter = 0  # 单调递增计数器，保证同优先级事件 FIFO

    @property
    def queue_size(self) -> int:
        """当前队列中的事件数量。"""
        return self._queue.qsize()

    async def publish(self, event: LiveEvent) -> None:
        """发布事件到总线。

        NORMAL 及以下优先级的事件会先经过采样策略过滤；
        HIGH/CRITICAL 级别事件直接入队。队列满时尝试淘汰
        低优先级事件以腾出空间。

        Args:
            event: 要发布的直播事件。
        """
        if event.priority.value >= EventPriority.NORMAL.value:
            should_keep = await self._sampling.should_keep(event)
            if not should_keep:
                return

        self._counter += 1
        item = (event.priority.value, self._counter, event)

        try:
            self._queue.put_nowait(item)
        except asyncio.QueueFull:
            dropped = self._try_drop_low_priority(event.priority.value)
            if dropped:
                self._queue.put_nowait(item)

    def _try_drop_low_priority(self, new_priority_value: int) -> bool:
        """尝试丢弃队列中优先级最低的事件以腾出空间。

        仅当被丢弃事件的优先级低于新事件时才执行替换，
        且不会丢弃 HIGH/CRITICAL 级别事件。
        """
        temp: list[tuple[int, int, LiveEvent]] = []
        lowest: tuple[int, int, LiveEvent] | None = None

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

        # 将非最低优先级的事件放回队列
        for item in temp:
            try:
                self._queue.put_nowait(item)
            except asyncio.QueueFull:
                pass

        if lowest is None:
            return False

        # 不丢弃 HIGH/CRITICAL 级别事件
        if lowest[0] < EventPriority.NORMAL.value:
            # 将 lowest 放回队列，不做丢弃
            try:
                self._queue.put_nowait(lowest)
            except asyncio.QueueFull:
                logger.warning("无法将事件放回已满队列，事件丢失: priority=%d", lowest[0])
            return False

        # 仅在新事件优先级高于被丢弃事件时才替换
        if new_priority_value < lowest[0]:
            logger.info("丢弃低优先级事件(priority=%d)以容纳高优先级事件(priority=%d)", lowest[0], new_priority_value)
            return True

        # 新事件优先级不高于被丢弃事件，放弃替换，将 lowest 放回
        try:
            self._queue.put_nowait(lowest)
        except asyncio.QueueFull:
            logger.warning("无法将事件放回已满队列，事件丢失: priority=%d", lowest[0])
        return False

    async def subscribe(self) -> AsyncIterator[LiveEvent]:
        """订阅事件流，持续产出队列中的事件。

        Yields:
            队列中按优先级排序的 LiveEvent 实例。
        """
        while True:
            _, _, event = await self._queue.get()
            yield event
            self._queue.task_done()

    async def flush(self) -> None:
        """清空队列中的所有事件。"""
        while not self._queue.empty():
            try:
                self._queue.get_nowait()
                self._queue.task_done()
            except asyncio.QueueEmpty:
                break
