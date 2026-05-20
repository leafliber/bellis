from __future__ import annotations

import collections
import inspect
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable

from bellis.core.actions import Action
from bellis.core.enums import EventPriority
from bellis.core.response import LiveResponse


class OutputMiddleware(ABC):
    @abstractmethod
    async def process(self, response: LiveResponse) -> LiveResponse | None: ...


class ActionMiddleware(ABC):
    """Action 级别的中间件，可在 Action 分发前进行过滤/修改。"""

    @abstractmethod
    async def process(self, action: Action) -> Action | None: ...


class OutputPipeline:
    def __init__(self) -> None:
        self._middlewares: list[OutputMiddleware] = []
        self._action_middlewares: list[ActionMiddleware] = []
        self._executors: list[Callable[[LiveResponse], Awaitable[None] | None]] = []

    def add_middleware(self, middleware: OutputMiddleware) -> OutputPipeline:
        self._middlewares.append(middleware)
        return self

    def add_action_middleware(self, middleware: ActionMiddleware) -> OutputPipeline:
        self._action_middlewares.append(middleware)
        return self

    def add_executor(self, executor: Callable[[LiveResponse], Awaitable[None] | None]) -> OutputPipeline:
        self._executors.append(executor)
        return self

    async def execute(self, response: LiveResponse) -> LiveResponse | None:
        current: LiveResponse | None = response
        for middleware in self._middlewares:
            if current is None:
                return None
            current = await middleware.process(current)
        if current is not None:
            for executor in self._executors:
                result = executor(current)
                if inspect.isawaitable(result):
                    await result
        return current

    async def process_action(self, action: Action) -> Action | None:
        """通过 Action 中间件链处理 Action。"""
        current: Action | None = action
        for middleware in self._action_middlewares:
            if current is None:
                return None
            current = await middleware.process(current)
        return current


class AuditMiddleware(OutputMiddleware):
    def __init__(
        self,
        sensitive_words: list[str] | None = None,
        replacement: str = "***",
        max_log_size: int = 1000,
    ) -> None:
        self._sensitive_words = sensitive_words or []
        self._replacement = replacement
        self._audit_log: collections.deque[dict] = collections.deque(maxlen=max_log_size)

    @property
    def audit_log(self) -> list[dict]:
        return list(self._audit_log)

    async def process(self, response: LiveResponse) -> LiveResponse | None:
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
            return response.model_copy(update={"text": text})
        return response


class ThrottleMiddleware(OutputMiddleware):
    def __init__(self, queue_limit: int = 20) -> None:
        self._queue_limit = queue_limit
        self._pending_count = 0

    def set_pending_count(self, count: int) -> None:
        self._pending_count = count

    async def process(self, response: LiveResponse) -> LiveResponse | None:
        if self._pending_count >= self._queue_limit:
            # 队列满时丢弃 LOW 优先级（value >= 3），保留 CRITICAL/HIGH/NORMAL
            if response.priority >= EventPriority.LOW.value:
                return None
        return response
