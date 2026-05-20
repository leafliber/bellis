"""事件采样策略模块。

提供多种采样策略用于控制事件流量，包括令牌桶限流
和聚合去重策略，防止高并发弹幕场景下系统过载。
"""

from __future__ import annotations

import logging
import time
from abc import ABC, abstractmethod
from collections import defaultdict
from datetime import datetime

from bellis.core.enums import EventPriority
from bellis.core.events import LiveEvent

logger = logging.getLogger(__name__)


class SamplingStrategy(ABC):
    """事件采样策略抽象基类。"""

    @abstractmethod
    async def should_keep(self, event: LiveEvent) -> bool:
        """判断事件是否应保留。

        Args:
            event: 待判定的直播事件。

        Returns:
            True 表示保留事件，False 表示丢弃。
        """
        ...


class TokenBucketStrategy(SamplingStrategy):
    """令牌桶采样策略，按 QPS 限流。

    以固定速率向桶中补充令牌，每次事件消耗一个令牌；
    桶空时丢弃事件。HIGH 及以上优先级事件直接放行。
    """

    def __init__(self, qps: float = 10.0) -> None:
        """初始化令牌桶策略。

        Args:
            qps: 每秒允许通过的事件数量，同时作为桶的最大容量。
        """
        self._qps = qps
        self._tokens = qps  # 初始令牌数等于桶容量，允许突发流量
        self._max_tokens = qps
        self._last_refill = time.monotonic()

    def _refill(self) -> None:
        """根据距上次补充的经过时间，向桶中添加令牌。"""
        now = time.monotonic()
        elapsed = now - self._last_refill
        self._tokens = min(self._max_tokens, self._tokens + elapsed * self._qps)
        self._last_refill = now

    async def should_keep(self, event: LiveEvent) -> bool:
        """判断事件是否应保留。

        HIGH 及以上优先级事件始终保留，其余事件需消耗令牌。

        Args:
            event: 待判定的直播事件。

        Returns:
            True 表示保留，False 表示因令牌不足而丢弃。
        """
        if event.priority.value <= EventPriority.HIGH.value:
            return True
        self._refill()
        if self._tokens >= 1.0:
            self._tokens -= 1.0
            return True
        logger.debug("TokenBucket 丢弃事件: source=%s tokens=%.1f", event.source.value, self._tokens)
        return False


class AggregateStrategy(SamplingStrategy):
    """聚合去重采样策略，在时间窗口内对相似内容进行聚合。

    当同一归一化内容在窗口内出现次数达到阈值后，
    仅放行首次聚合事件，窗口内后续重复事件被丢弃，
    防止刷屏类弹幕淹没正常交互。
    """

    def __init__(self, window_seconds: float = 2.0, threshold: int = 3, max_keys: int = 1000) -> None:
        """初始化聚合策略。

        Args:
            window_seconds: 聚合时间窗口（秒）。
            threshold: 触发聚合去重的事件计数阈值。
            max_keys: 最大追踪键数，防止内存无限增长。
        """
        self._window_seconds = window_seconds
        self._threshold = threshold
        self._max_keys = max_keys
        self._buckets: dict[str, list[datetime]] = defaultdict(list)  # 内容 -> 时间戳列表
        self._emitted: dict[str, datetime] = {}  # 内容 -> 最近放行时间

    def _normalize(self, content: str) -> str:
        """将内容归一化为小写并去除首尾空白，用于聚合匹配。

        Args:
            content: 原始事件内容。

        Returns:
            归一化后的字符串。
        """
        return content.strip().lower()

    def _evict_stale_keys(self, now: datetime) -> None:
        """淘汰过期的 key，防止内存无限增长。"""
        stale = [
            k for k, times in self._buckets.items()
            if not times or (now - times[-1]).total_seconds() >= self._window_seconds
        ]
        for k in stale:
            self._buckets.pop(k, None)
            self._emitted.pop(k, None)

    async def should_keep(self, event: LiveEvent) -> bool:
        """判断事件是否应保留。

        HIGH 及以上优先级事件始终保留。其余事件按内容归一化后
        在时间窗口内聚合：未达阈值前全部保留，达到阈值后
        仅在窗口内首次聚合时放行。

        Args:
            event: 待判定的直播事件。

        Returns:
            True 表示保留，False 表示因聚合去重而丢弃。
        """
        if event.priority.value <= EventPriority.HIGH.value:
            return True
        key = self._normalize(event.content)
        now = datetime.now()
        # 每次调用都清理过期 key
        self._evict_stale_keys(now)
        self._buckets[key] = [t for t in self._buckets[key] if (now - t).total_seconds() < self._window_seconds]
        self._buckets[key].append(now)
        count = len(self._buckets[key])
        if count >= self._threshold:
            last_emitted = self._emitted.get(key)
            if last_emitted and (now - last_emitted).total_seconds() < self._window_seconds:
                logger.debug("AggregateStrategy 聚合丢弃: key=%r count=%d", key[:50], count)
                return False
            self._emitted[key] = now
            return True
        # 未达到阈值前保留所有事件
        return True
