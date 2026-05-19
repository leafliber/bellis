import pytest

from bellis.core.enums import EventPriority
from bellis.core.events import LiveEvent
from bellis.input.bus import EventBus
from bellis.input.sampling import AggregateStrategy, TokenBucketStrategy


class TestEventBus:
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
