"""EventBus 及采样策略的单元测试。

验证事件总线的发布/订阅、优先级排序、清空功能，
以及 TokenBucketStrategy 和 AggregateStrategy 的采样逻辑。
"""

import pytest

from bellis.core.enums import EventPriority
from bellis.core.events import LiveEvent
from bellis.runtime.bus import EventBus
from bellis.runtime.sampling import AggregateStrategy, TokenBucketStrategy


class TestEventBus:
    """EventBus 核心功能测试。"""
    @pytest.mark.asyncio
    async def test_publish_and_subscribe(self):
        bus = EventBus(maxsize=10, sampling=TokenBucketStrategy(qps=100))
        event = LiveEvent(content="test", priority=EventPriority.HIGH)
        await bus.publish(event)
        assert bus.queue_size == 1

    @pytest.mark.asyncio
    async def test_priority_ordering(self):
        bus = EventBus(maxsize=10, sampling=TokenBucketStrategy(qps=100))
        low = LiveEvent(content="low", priority=EventPriority.LOW)
        high = LiveEvent(content="high", priority=EventPriority.HIGH)
        critical = LiveEvent(content="critical", priority=EventPriority.CRITICAL)
        await bus.publish(low)
        await bus.publish(high)
        await bus.publish(critical)
        events = []
        for _ in range(3):
            async for event in bus.subscribe():
                events.append(event)
                break
        assert events[0].priority == EventPriority.CRITICAL

    @pytest.mark.asyncio
    async def test_flush(self):
        bus = EventBus(maxsize=10, sampling=TokenBucketStrategy(qps=100))
        await bus.publish(LiveEvent(content="1"))
        await bus.publish(LiveEvent(content="2"))
        assert bus.queue_size == 2
        await bus.flush()
        assert bus.queue_size == 0


class TestTokenBucketStrategy:
    """令牌桶采样策略测试。"""
    @pytest.mark.asyncio
    async def test_high_priority_always_pass(self):
        strategy = TokenBucketStrategy(qps=0)
        event = LiveEvent(content="test", priority=EventPriority.HIGH)
        assert await strategy.should_keep(event) is True

    @pytest.mark.asyncio
    async def test_rate_limiting(self):
        strategy = TokenBucketStrategy(qps=1.0)
        strategy._tokens = 0
        event = LiveEvent(content="test", priority=EventPriority.NORMAL)
        assert await strategy.should_keep(event) is False


class TestAggregateStrategy:
    """聚合采样策略测试。"""
    @pytest.mark.asyncio
    async def test_high_priority_always_pass(self):
        strategy = AggregateStrategy()
        event = LiveEvent(content="test", priority=EventPriority.HIGH)
        assert await strategy.should_keep(event) is True

    @pytest.mark.asyncio
    async def test_first_occurrence_passes(self):
        strategy = AggregateStrategy()
        event = LiveEvent(content="hello", priority=EventPriority.NORMAL)
        assert await strategy.should_keep(event) is True


class TestEventBusBackpressure:
    """EventBus 背压/队列满时的淘汰策略测试。"""

    @pytest.mark.asyncio
    async def test_queue_full_drops_low_priority(self):
        """队列满时，发布高优先级事件应淘汰低优先级事件。"""
        # 使用极低 qps 避免采样干扰，maxsize=2 限制队列大小
        bus = EventBus(maxsize=2, sampling=TokenBucketStrategy(qps=100))
        # 先填满队列：两个低优先级事件
        await bus.publish(LiveEvent(content="low1", priority=EventPriority.LOW))
        await bus.publish(LiveEvent(content="low2", priority=EventPriority.LOW))
        assert bus.queue_size == 2
        # 再发布一个高优先级事件，应淘汰一个低优先级事件
        await bus.publish(LiveEvent(content="high", priority=EventPriority.HIGH))
        assert bus.queue_size == 2
        # 从队列中取出事件，应包含高优先级事件
        events = []
        for _ in range(2):
            async for event in bus.subscribe():
                events.append(event)
                break
        # 高优先级事件应该在队列中
        assert any(e.content == "high" for e in events)

    @pytest.mark.asyncio
    async def test_queue_full_keeps_high_priority(self):
        """队列满时，低优先级事件不能淘汰高优先级事件。"""
        bus = EventBus(maxsize=2, sampling=TokenBucketStrategy(qps=100))
        # 填满队列：两个高优先级事件
        await bus.publish(LiveEvent(content="high1", priority=EventPriority.HIGH))
        await bus.publish(LiveEvent(content="high2", priority=EventPriority.HIGH))
        assert bus.queue_size == 2
        # 尝试发布低优先级事件，不应淘汰高优先级事件
        await bus.publish(LiveEvent(content="low", priority=EventPriority.LOW))
        # 队列大小仍为 2，低优先级事件被拒绝
        assert bus.queue_size == 2
        # 取出所有事件，应该都是高优先级
        events = []
        for _ in range(2):
            async for event in bus.subscribe():
                events.append(event)
                break
        assert all(e.priority == EventPriority.HIGH for e in events)

    @pytest.mark.asyncio
    async def test_subscribe_yields_in_priority_order(self):
        """订阅时应按优先级顺序产出事件：CRITICAL -> HIGH -> NORMAL -> LOW。"""
        bus = EventBus(maxsize=10, sampling=TokenBucketStrategy(qps=100))
        # 按非优先级顺序发布事件
        await bus.publish(LiveEvent(content="low", priority=EventPriority.LOW))
        await bus.publish(LiveEvent(content="critical", priority=EventPriority.CRITICAL))
        await bus.publish(LiveEvent(content="normal", priority=EventPriority.NORMAL))
        await bus.publish(LiveEvent(content="high", priority=EventPriority.HIGH))
        # 按顺序取出，验证优先级排序
        priorities = []
        for _ in range(4):
            async for event in bus.subscribe():
                priorities.append(event.priority)
                break
        assert priorities == [
            EventPriority.CRITICAL,
            EventPriority.HIGH,
            EventPriority.NORMAL,
            EventPriority.LOW,
        ]


class TestEventBusSampling:
    """EventBus 与采样策略的集成测试。"""

    @pytest.mark.asyncio
    async def test_normal_event_filtered_by_sampling(self):
        """令牌桶耗尽时，NORMAL 事件应被采样策略过滤。"""
        # qps=0 且初始令牌为 0，所有 NORMAL 事件都会被过滤
        strategy = TokenBucketStrategy(qps=0)
        strategy._tokens = 0
        bus = EventBus(maxsize=10, sampling=strategy)
        await bus.publish(LiveEvent(content="filtered", priority=EventPriority.NORMAL))
        # NORMAL 事件被采样策略拦截，不应入队
        assert bus.queue_size == 0

    @pytest.mark.asyncio
    async def test_critical_event_bypasses_sampling(self):
        """令牌桶耗尽时，CRITICAL 事件仍应绕过采样直接入队。"""
        strategy = TokenBucketStrategy(qps=0)
        strategy._tokens = 0
        bus = EventBus(maxsize=10, sampling=strategy)
        await bus.publish(LiveEvent(content="critical_msg", priority=EventPriority.CRITICAL))
        # CRITICAL 事件绕过采样，应成功入队
        assert bus.queue_size == 1


class TestTokenBucketAdvanced:
    """令牌桶策略高级测试：令牌补充与连续限流。"""

    @pytest.mark.asyncio
    async def test_tokens_replenish_over_time(self):
        """等待一段时间后令牌应得到补充，事件可以再次通过。"""
        # qps=1000，令牌补充速率很快
        strategy = TokenBucketStrategy(qps=1000)
        # 耗尽令牌
        strategy._tokens = 0
        event = LiveEvent(content="first", priority=EventPriority.NORMAL)
        assert await strategy.should_keep(event) is False
        # 等待一小段时间让令牌补充
        import asyncio
        await asyncio.sleep(0.01)
        # 再次尝试，令牌应该已经补充，事件可以通过
        event2 = LiveEvent(content="second", priority=EventPriority.NORMAL)
        assert await strategy.should_keep(event2) is True

    @pytest.mark.asyncio
    async def test_multiple_normal_events_rate_limited(self):
        """快速连续发送多个 NORMAL 事件时，部分事件应被限流过滤。"""
        # qps=1，桶容量为 1，初始令牌也为 1
        strategy = TokenBucketStrategy(qps=1)
        # 将初始令牌设为 1，只允许第一个事件通过
        strategy._tokens = 1
        results = []
        for i in range(5):
            event = LiveEvent(content=f"msg_{i}", priority=EventPriority.NORMAL)
            results.append(await strategy.should_keep(event))
        # 第一个事件通过（消耗最后一个令牌），后续事件被限流
        assert results[0] is True
        # 后续事件中至少有一个被过滤
        assert False in results[1:]
