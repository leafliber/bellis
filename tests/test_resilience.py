"""弹性调用（CircuitBreaker + ResilientCaller）的单元测试。

验证熔断器的三种状态转换（closed → open → half_open → closed）
以及 ResilientCaller 的重试和降级回退逻辑。
"""

import asyncio

import pytest

from bellis.agent.decision import CircuitBreaker, CircuitOpenError, ResilientCaller
from bellis.core.enums import EmotionEnum, MotionEnum
from bellis.core.response import LiveResponse


async def _ok():
    """模拟成功调用。"""
    return "ok"


async def _fail():
    """模拟失败调用。"""
    raise RuntimeError("fail")


async def _recovered():
    """模拟恢复后的成功调用。"""
    return "recovered"


class TestCircuitBreaker:
    """CircuitBreaker 熔断器状态转换测试。"""
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
    """ResilientCaller 重试和降级回退测试。"""
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


class TestResilientCallerFallback:
    """ResilientCaller 回退模型与兜底响应测试。"""

    @pytest.mark.asyncio
    async def test_fallback_model_tried_after_retries(self):
        """所有重试失败后，应尝试使用 fallback_model 调用。"""
        call_count = 0

        class FakeAgent:
            async def run(self, *args, **kwargs):
                nonlocal call_count
                call_count += 1
                # 无论是否指定 model 参数，都抛出异常
                raise RuntimeError("always fails")

        caller = ResilientCaller(max_retries=2, base_delay=0.0, fallback_model="fallback-model")
        await caller.call_with_retry(FakeAgent(), "test prompt", None)
        # max_retries=2 意味着尝试 2 次主调用，然后 1 次回退模型调用，共 3 次
        assert call_count == 3

    @pytest.mark.asyncio
    async def test_fallback_model_success(self):
        """当回退模型调用成功时，应返回回退模型的结果。"""
        from unittest.mock import MagicMock

        # 模拟主模型始终失败，回退模型成功
        class FakeAgent:
            async def run(self, *args, **kwargs):
                if kwargs.get("model") == "fallback-model":
                    # 回退模型成功
                    result = MagicMock()
                    result.get_output.return_value = LiveResponse(
                        text="回退成功", emotion=EmotionEnum.calm, motion=MotionEnum.idle
                    )
                    return result
                # 主模型失败
                raise RuntimeError("primary model fails")

        caller = ResilientCaller(max_retries=1, base_delay=0.0, fallback_model="fallback-model")
        response = await caller.call_with_retry(FakeAgent(), "test prompt", None)
        assert response.text == "回退成功"

    @pytest.mark.asyncio
    async def test_all_fail_returns_fallback_response(self):
        """主模型和回退模型全部失败时，返回默认兜底响应。"""
        class FakeAgent:
            async def run(self, *args, **kwargs):
                raise RuntimeError("everything fails")

        caller = ResilientCaller(max_retries=1, base_delay=0.0, fallback_model="fallback-model")
        response = await caller.call_with_retry(FakeAgent(), "test prompt", None)
        # 返回默认兜底响应
        assert response.text == "让我想想..."
        assert response.emotion == EmotionEnum.calm
        assert response.motion == MotionEnum.think


class TestCircuitBreakerAdvanced:
    """CircuitBreaker 进阶测试：half_open 失败回退与成功重置。"""

    @pytest.mark.asyncio
    async def test_half_open_failure_returns_to_open(self):
        """half_open 状态下调用失败，应回到 open 状态。"""
        breaker = CircuitBreaker(failure_threshold=1, recovery_timeout=0.0)
        # 第一次失败触发熔断
        with pytest.raises(RuntimeError):
            await breaker.call(_fail)
        assert breaker.state == "open"

        # 等待恢复超时，进入 half_open
        await asyncio.sleep(0.01)
        # half_open 下再次失败，应回到 open
        with pytest.raises(RuntimeError):
            await breaker.call(_fail)
        assert breaker.state == "open"

    @pytest.mark.asyncio
    async def test_failure_count_resets_on_success(self):
        """成功调用后 failure_count 应重置为 0。"""
        breaker = CircuitBreaker(failure_threshold=3)
        # 先制造 2 次失败
        for _ in range(2):
            with pytest.raises(RuntimeError):
                await breaker.call(_fail)
        assert breaker.failure_count == 2

        # 一次成功调用重置 failure_count
        result = await breaker.call(_ok)
        assert result == "ok"
        assert breaker.failure_count == 0
        assert breaker.state == "closed"
