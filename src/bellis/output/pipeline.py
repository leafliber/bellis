from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Callable

from bellis.core.actions import Action
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
        self._executors: list[Callable[[LiveResponse], None]] = []

    def add_middleware(self, middleware: OutputMiddleware) -> OutputPipeline:
        self._middlewares.append(middleware)
        return self

    def add_action_middleware(self, middleware: ActionMiddleware) -> OutputPipeline:
        self._action_middlewares.append(middleware)
        return self

    def add_executor(self, executor: Callable[[LiveResponse], None]) -> OutputPipeline:
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
                executor(current)
        return current

    async def process_action(self, action: Action) -> Action | None:
        """通过 Action 中间件链处理 Action。"""
        current: Action | None = action
        for middleware in self._action_middlewares:
            if current is None:
                return None
            current = await middleware.process(current)
        return current
