"""输出管道及中间件的单元测试。

验证审计中间件（敏感词过滤）、节流中间件（队列超限丢弃低优先级）
以及 OutputPipeline 的中间件链式执行逻辑。
"""

import pytest

from bellis.core.actions import Action
from bellis.core.enums import ActionType, EmotionEnum, EventPriority
from bellis.core.response import LiveResponse
from bellis.runtime.middleware import ActionMiddleware, AuditMiddleware, OutputPipeline, ThrottleMiddleware


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


class TestActionMiddleware:
    """Action 中间件测试：修改和过滤 Action。"""

    @pytest.mark.asyncio
    async def test_action_middleware_modifies_action(self):
        """自定义 ActionMiddleware 可以修改 action 的文本。"""

        # 自定义中间件：给 action 文本加上前缀
        class PrefixMiddleware(ActionMiddleware):
            async def process(self, action: Action) -> Action | None:
                return action.model_copy(update={"text": f"[已审核] {action.text}"})

        middleware = PrefixMiddleware()
        action = Action(type=ActionType.speak, text="你好世界", emotion=EmotionEnum.happy)
        result = await middleware.process(action)
        assert result is not None
        assert result.text == "[已审核] 你好世界"

    @pytest.mark.asyncio
    async def test_action_middleware_returns_none_drops_action(self):
        """ActionMiddleware 返回 None 表示丢弃该 Action。"""

        # 自定义中间件：过滤掉包含"违禁"的 action
        class DropMiddleware(ActionMiddleware):
            async def process(self, action: Action) -> Action | None:
                if action.text and "违禁" in action.text:
                    return None
                return action

        middleware = DropMiddleware()
        # 包含违禁词的 action 应被丢弃
        bad_action = Action(type=ActionType.speak, text="这是违禁内容", emotion=EmotionEnum.happy)
        result = await middleware.process(bad_action)
        assert result is None

        # 正常 action 应通过
        good_action = Action(type=ActionType.speak, text="正常内容", emotion=EmotionEnum.happy)
        result = await middleware.process(good_action)
        assert result is not None
        assert result.text == "正常内容"

    @pytest.mark.asyncio
    async def test_pipeline_process_action_chain(self):
        """多个 ActionMiddleware 在管线中按顺序链式执行。"""

        # 第一个中间件：给文本加前缀
        class PrefixMiddleware(ActionMiddleware):
            def __init__(self, prefix: str):
                self._prefix = prefix

            async def process(self, action: Action) -> Action | None:
                return action.model_copy(update={"text": f"{self._prefix}{action.text}"})

        # 第二个中间件：过滤包含"丢弃"的 action
        class DropKeywordMiddleware(ActionMiddleware):
            async def process(self, action: Action) -> Action | None:
                if action.text and "丢弃" in action.text:
                    return None
                return action

        pipeline = OutputPipeline()
        pipeline.add_action_middleware(PrefixMiddleware("[A]"))
        pipeline.add_action_middleware(PrefixMiddleware("[B]"))

        # 验证链式修改：第二个中间件在前缀前再加前缀，结果为 [B][A]你好
        action = Action(type=ActionType.speak, text="你好", emotion=EmotionEnum.happy)
        result = await pipeline.process_action(action)
        assert result is not None
        assert result.text == "[B][A]你好"

        # 验证短路逻辑：中间件返回 None 时终止后续处理
        pipeline2 = OutputPipeline()
        pipeline2.add_action_middleware(DropKeywordMiddleware())
        pipeline2.add_action_middleware(PrefixMiddleware("[B]"))

        drop_action = Action(type=ActionType.speak, text="请丢弃我", emotion=EmotionEnum.happy)
        result2 = await pipeline2.process_action(drop_action)
        assert result2 is None


class TestAuditMiddlewareAdvanced:
    """审计中间件进阶测试：多敏感词、无敏感词、日志容量限制。"""

    @pytest.mark.asyncio
    async def test_multiple_sensitive_words(self):
        """文本中包含多个不同的敏感词时，全部被替换。"""
        middleware = AuditMiddleware(sensitive_words=["违禁词", "敏感词", "屏蔽词"], replacement="***")
        response = LiveResponse(text="违禁词和敏感词还有屏蔽词都在这里", emotion=EmotionEnum.happy)
        result = await middleware.process(response)
        assert result is not None
        assert "违禁词" not in result.text
        assert "敏感词" not in result.text
        assert "屏蔽词" not in result.text
        # 所有敏感词都被替换为 ***
        assert result.text.count("***") == 3
        assert len(middleware.audit_log) == 1

    @pytest.mark.asyncio
    async def test_no_sensitive_words_passes_through(self):
        """不包含任何敏感词的文本原样通过，不做修改。"""
        middleware = AuditMiddleware(sensitive_words=["违禁词", "敏感词"], replacement="***")
        response = LiveResponse(text="这是一段完全正常的文本", emotion=EmotionEnum.calm)
        result = await middleware.process(response)
        assert result is not None
        assert result.text == "这是一段完全正常的文本"
        # 没有过滤记录
        assert len(middleware.audit_log) == 0

    @pytest.mark.asyncio
    async def test_audit_log_max_size(self):
        """审计日志遵循 max_log_size 限制，超出后淘汰最旧记录。"""
        max_size = 3
        middleware = AuditMiddleware(sensitive_words=["坏词"], replacement="***", max_log_size=max_size)
        # 连续处理 5 个包含敏感词的响应
        for i in range(5):
            response = LiveResponse(text=f"第{i}个坏词测试", emotion=EmotionEnum.happy)
            await middleware.process(response)
        # 日志只保留最近 max_size 条
        assert len(middleware.audit_log) == max_size
        # 最旧的记录（第0、1条）已被淘汰，保留第2、3、4条
        log_texts = [entry["original_text"] for entry in middleware.audit_log]
        assert "第2个坏词测试" in log_texts
        assert "第3个坏词测试" in log_texts
        assert "第4个坏词测试" in log_texts


class TestThrottleMiddlewareAdvanced:
    """节流中间件进阶测试：CRITICAL/HIGH 优先级在超限时的行为。"""

    @pytest.mark.asyncio
    async def test_critical_priority_always_passes(self):
        """CRITICAL 优先级（value=0）即使队列超限也始终通过。"""
        middleware = ThrottleMiddleware(queue_limit=20)
        middleware.set_pending_count(100)  # 远超限制
        # priority=0 即 CRITICAL
        response = LiveResponse(text="紧急消息", priority=EventPriority.CRITICAL.value)
        result = await middleware.process(response)
        assert result is not None
        assert result.text == "紧急消息"

    @pytest.mark.asyncio
    async def test_high_priority_passes_when_over_limit(self):
        """HIGH 优先级（value=1）在队列超限时仍通过。"""
        middleware = ThrottleMiddleware(queue_limit=20)
        middleware.set_pending_count(25)  # 超过限制
        # priority=1 即 HIGH
        response = LiveResponse(text="重要消息", priority=EventPriority.HIGH.value)
        result = await middleware.process(response)
        assert result is not None
        assert result.text == "重要消息"
