import asyncio

import pytest

from bellis.agent.decision import CircuitBreaker, CircuitOpenError, ResilientCaller
from bellis.core.enums import EmotionEnum, MotionEnum


async def _ok():
    return "ok"


async def _fail():
    raise RuntimeError("fail")


async def _recovered():
    return "recovered"


class TestCircuitBreaker:
    @pytest.mark.asyncio
    async def test_closed_state_passes(self):
        breaker = CircuitBreaker(failure_threshold=3)
        result = await breaker.call(_ok)
        assert result == "ok"
        assert breaker.state == "closed"

    @pytest.mark.asyncio
    async def test_opens_after_threshold(self):
        breaker = CircuitBreaker(failure_threshold=3, recovery_timeout=100.0)
        for _ in range(3):
            with pytest.raises(RuntimeError):
                await breaker.call(_fail)
        assert breaker.state == "open"

    @pytest.mark.asyncio
    async def test_open_state_raises_circuit_open(self):
        breaker = CircuitBreaker(failure_threshold=1, recovery_timeout=100.0)
        with pytest.raises(Exception):
            await breaker.call(_fail)
        assert breaker.state == "open"
        with pytest.raises(CircuitOpenError):
            await breaker.call(_ok)

    @pytest.mark.asyncio
    async def test_half_open_allows_probe(self):
        breaker = CircuitBreaker(failure_threshold=1, recovery_timeout=0.0)
        with pytest.raises(Exception):
            await breaker.call(_fail)
        assert breaker.state == "open"
        await asyncio.sleep(0.01)
        result = await breaker.call(_recovered)
        assert result == "recovered"
        assert breaker.state == "closed"


class TestResilientCaller:
    @pytest.mark.asyncio
    async def test_fallback_response(self):
        caller = ResilientCaller(max_retries=1, fallback_model=None)

        class FakeAgent:
            async def run(self, *args, **kwargs):
                raise RuntimeError("always fails")

        response = await caller.call_with_retry(FakeAgent(), "test prompt", None)
        assert response.text == "让我想想..."
        assert response.emotion == EmotionEnum.calm
        assert response.motion == MotionEnum.think
