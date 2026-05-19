from __future__ import annotations

import time
from abc import ABC, abstractmethod
from collections import defaultdict
from datetime import datetime

from bellis.core.enums import EventPriority
from bellis.core.events import LiveEvent


class SamplingStrategy(ABC):
    @abstractmethod
    async def should_keep(self, event: LiveEvent) -> bool: ...


class TokenBucketStrategy(SamplingStrategy):
    def __init__(self, qps: float = 10.0) -> None:
        self._qps = qps
        self._tokens = qps
        self._max_tokens = qps
        self._last_refill = time.monotonic()

    def _refill(self) -> None:
        now = time.monotonic()
        elapsed = now - self._last_refill
        self._tokens = min(self._max_tokens, self._tokens + elapsed * self._qps)
        self._last_refill = now

    async def should_keep(self, event: LiveEvent) -> bool:
        if event.priority.value <= EventPriority.HIGH.value:
            return True
        self._refill()
        if self._tokens >= 1.0:
            self._tokens -= 1.0
            return True
        return False


class AggregateStrategy(SamplingStrategy):
    def __init__(self, window_seconds: float = 2.0, threshold: int = 3) -> None:
        self._window_seconds = window_seconds
        self._threshold = threshold
        self._buckets: dict[str, list[datetime]] = defaultdict(list)
        self._emitted: dict[str, datetime] = {}

    def _normalize(self, content: str) -> str:
        return content.strip().lower()

    async def should_keep(self, event: LiveEvent) -> bool:
        if event.priority.value <= EventPriority.HIGH.value:
            return True
        key = self._normalize(event.content)
        now = datetime.now()
        self._buckets[key] = [t for t in self._buckets[key] if (now - t).total_seconds() < self._window_seconds]
        self._buckets[key].append(now)
        if len(self._buckets[key]) >= self._threshold:
            last_emitted = self._emitted.get(key)
            if last_emitted and (now - last_emitted).total_seconds() < self._window_seconds:
                return False
            self._emitted[key] = now
            return True
        return len(self._buckets[key]) == 1
