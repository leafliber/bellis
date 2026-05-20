"""输出中间件与处理管线模块。

提供输出响应和动作的中间件抽象基类、管线编排，
以及内置的审计过滤和限流中间件实现。
"""

from __future__ import annotations

import collections
import inspect
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable

from bellis.core.actions import Action
from bellis.core.enums import EventPriority
from bellis.core.response import LiveResponse


class OutputMiddleware(ABC):
    """输出响应中间件抽象基类。

    可在 LiveResponse 经过管线时对其进行过滤或修改，
    返回 None 表示丢弃该响应。
    """

    @abstractmethod
    async def process(self, response: LiveResponse) -> LiveResponse | None:
        """处理输出响应。

        Args:
            response: 待处理的直播响应。

        Returns:
            处理后的 LiveResponse，或 None 表示丢弃。
        """
        ...


class ActionMiddleware(ABC):
    """Action 级别的中间件，可在 Action 分发前进行过滤/修改。

    返回 None 表示丢弃该 Action。
    """

    @abstractmethod
    async def process(self, action: Action) -> Action | None:
        """处理动作。

        Args:
            action: 待处理的 Action 实例。

        Returns:
            处理后的 Action，或 None 表示丢弃。
        """
        ...


class OutputPipeline:
    """输出处理管线，串联中间件和执行器。

    支持两层处理：OutputMiddleware 链处理 LiveResponse，
    ActionMiddleware 链处理 Action。处理完成后调用执行器
    执行最终输出。
    """

    def __init__(self) -> None:
        self._middlewares: list[OutputMiddleware] = []
        self._action_middlewares: list[ActionMiddleware] = []
        self._executors: list[Callable[[LiveResponse], Awaitable[None] | None]] = []

    def add_middleware(self, middleware: OutputMiddleware) -> OutputPipeline:
        """添加输出中间件到管线。

        Args:
            middleware: 输出中间件实例。

        Returns:
            自身，支持链式调用。
        """
        self._middlewares.append(middleware)
        return self

    def add_action_middleware(self, middleware: ActionMiddleware) -> OutputPipeline:
        """添加 Action 中间件到管线。

        Args:
            middleware: Action 中间件实例。

        Returns:
            自身，支持链式调用。
        """
        self._action_middlewares.append(middleware)
        return self

    def add_executor(self, executor: Callable[[LiveResponse], Awaitable[None] | None]) -> OutputPipeline:
        """添加执行器到管线，中间件处理完成后依次调用。

        Args:
            executor: 执行器函数，支持同步和异步两种形式。

        Returns:
            自身，支持链式调用。
        """
        self._executors.append(executor)
        return self

    async def execute(self, response: LiveResponse) -> LiveResponse | None:
        """执行输出管线：先通过中间件链处理，再调用执行器。

        任一中间件返回 None 则终止后续处理。

        Args:
            response: 待处理的直播响应。

        Returns:
            经过中间件链处理后的 LiveResponse，或 None 表示被丢弃。
        """
        current: LiveResponse | None = response
        for middleware in self._middlewares:
            if current is None:
                return None
            current = await middleware.process(current)
        if current is not None:
            for executor in self._executors:
                result = executor(current)
                if inspect.isawaitable(result):  # 兼容同步和异步执行器
                    await result
        return current

    async def process_action(self, action: Action) -> Action | None:
        """通过 Action 中间件链处理 Action。

        任一中间件返回 None 则终止后续处理。

        Args:
            action: 待处理的 Action 实例。

        Returns:
            处理后的 Action，或 None 表示被丢弃。
        """
        current: Action | None = action
        for middleware in self._action_middlewares:
            if current is None:
                return None
            current = await middleware.process(current)
        return current


class AuditMiddleware(OutputMiddleware):
    """审计过滤中间件，对响应文本进行敏感词替换并记录审计日志。

    Attributes:
        audit_log: 审计日志列表，包含被过滤的原始文本、过滤后文本和情感信息。
    """

    def __init__(
        self,
        sensitive_words: list[str] | None = None,
        replacement: str = "***",
        max_log_size: int = 1000,
    ) -> None:
        """初始化审计中间件。

        Args:
            sensitive_words: 敏感词列表，匹配到的词将被替换。
            replacement: 敏感词替换字符串，默认为 "***"。
            max_log_size: 审计日志最大条数，超出后自动淘汰最旧记录。
        """
        self._sensitive_words = sensitive_words or []
        self._replacement = replacement
        self._audit_log: collections.deque[dict] = collections.deque(maxlen=max_log_size)

    @property
    def audit_log(self) -> list[dict]:
        """获取审计日志的快照列表。"""
        return list(self._audit_log)

    async def process(self, response: LiveResponse) -> LiveResponse | None:
        """对响应文本执行敏感词替换，并在有替换时记录审计日志。

        Args:
            response: 待处理的直播响应。

        Returns:
            若文本被修改则返回新副本，否则返回原始响应。
        """
        text = response.text
        replaced = False
        for word in self._sensitive_words:
            if word in text:
                text = text.replace(word, self._replacement)
                replaced = True
        if replaced:
            self._audit_log.append(
                {
                    "original_text": response.text,
                    "filtered_text": text,
                    "emotion": response.emotion.value,
                }
            )
            return response.model_copy(update={"text": text})  # 创建副本以避免修改原始对象
        return response


class ThrottleMiddleware(OutputMiddleware):
    """限流中间件，当 TTS 待合成队列满时丢弃低优先级响应。

    通过外部调用 set_pending_count 更新当前队列深度，
    超过限制时仅保留 CRITICAL/HIGH/NORMAL 优先级的响应。
    """

    def __init__(self, queue_limit: int = 20) -> None:
        """初始化限流中间件。

        Args:
            queue_limit: TTS 队列最大长度，超出后开始丢弃低优先级响应。
        """
        self._queue_limit = queue_limit
        self._pending_count = 0

    def set_pending_count(self, count: int) -> None:
        """更新当前 TTS 待合成队列深度。

        Args:
            count: 当前队列中的待处理数量。
        """
        self._pending_count = count

    async def process(self, response: LiveResponse) -> LiveResponse | None:
        """根据队列深度和响应优先级决定是否丢弃。

        队列满时丢弃 LOW 优先级响应，保留更高优先级。

        Args:
            response: 待处理的直播响应。

        Returns:
            通过限流检查的 LiveResponse，或 None 表示被丢弃。
        """
        if self._pending_count >= self._queue_limit:
            # 队列满时丢弃 LOW 优先级（value >= 3），保留 CRITICAL/HIGH/NORMAL
            if response.priority >= EventPriority.LOW.value:
                return None
        return response
