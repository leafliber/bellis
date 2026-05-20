import pytest

from bellis.core.enums import EmotionEnum
from bellis.core.response import LiveResponse
from bellis.runtime.middleware import AuditMiddleware, OutputPipeline, ThrottleMiddleware


class TestAuditMiddleware:
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
