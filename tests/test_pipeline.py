"""输出管道及中间件的单元测试。

验证审计中间件（敏感词过滤）、节流中间件（队列超限丢弃低优先级）
以及 OutputPipeline 的中间件链式执行逻辑。
"""

import pytest

from bellis.core.enums import EmotionEnum
from bellis.core.response import LiveResponse
from bellis.runtime.middleware import AuditMiddleware, OutputPipeline, ThrottleMiddleware


class TestAuditMiddleware:
    """审计中间件测试：敏感词过滤和替换。"""
    @pytest.mark.asyncio
    async def test_pass_clean_text(self):
        middleware = AuditMiddleware(sensitive_words=["违禁词"])
        response = LiveResponse(text="你好世界", emotion=EmotionEnum.happy)
        result = await middleware.process(response)
        assert result is not None
        assert result.text == "你好世界"

    @pytest.mark.asyncio
    async def test_filter_sensitive_word(self):
        middleware = AuditMiddleware(sensitive_words=["违禁词"], replacement="***")
        response = LiveResponse(text="这是一个违禁词测试", emotion=EmotionEnum.happy)
        result = await middleware.process(response)
        assert result is not None
        assert "违禁词" not in result.text
        assert "***" in result.text
        assert len(middleware.audit_log) == 1


class TestThrottleMiddleware:
    """节流中间件测试：队列超限时丢弃低优先级响应。"""
    @pytest.mark.asyncio
    async def test_pass_when_under_limit(self):
        middleware = ThrottleMiddleware(queue_limit=20)
        middleware.set_pending_count(5)
        response = LiveResponse(text="test")
        result = await middleware.process(response)
        assert result is not None

    @pytest.mark.asyncio
    async def test_drop_low_priority_when_over_limit(self):
        middleware = ThrottleMiddleware(queue_limit=20)
        middleware.set_pending_count(25)
        # priority=3 即 LOW，超限时会被丢弃
        response = LiveResponse(text="test", priority=3)
        result = await middleware.process(response)
        assert result is None

    @pytest.mark.asyncio
    async def test_keep_normal_priority_when_over_limit(self):
        middleware = ThrottleMiddleware(queue_limit=20)
        middleware.set_pending_count(25)
        # priority=2 即 NORMAL，超限时仍保留
        response = LiveResponse(text="test", priority=2)
        result = await middleware.process(response)
        assert result is not None


class TestOutputPipeline:
    """输出管道测试：中间件链式执行和短路逻辑。"""
    @pytest.mark.asyncio
    async def test_pipeline_with_middleware(self):
        pipeline = OutputPipeline()
        pipeline.add_middleware(AuditMiddleware(sensitive_words=["bad"]))
        executed = []
        pipeline.add_executor(lambda r: executed.append(r.text))
        response = LiveResponse(text="hello bad world", emotion=EmotionEnum.happy)
        result = await pipeline.execute(response)
        assert result is not None
        assert "bad" not in result.text
        assert len(executed) == 1

    @pytest.mark.asyncio
    async def test_pipeline_middleware_returns_none(self):
        pipeline = OutputPipeline()
        pipeline.add_middleware(ThrottleMiddleware(queue_limit=5))
        middleware = pipeline._middlewares[0]
        middleware.set_pending_count(10)
        executed = []
        pipeline.add_executor(lambda r: executed.append(r.text))
        response = LiveResponse(text="test", priority=3)
        result = await pipeline.execute(response)
        assert result is None
        assert len(executed) == 0
