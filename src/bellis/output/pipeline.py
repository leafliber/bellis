from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Callable

from bellis.core.response import LiveResponse


class OutputMiddleware(ABC):
    @abstractmethod
    async def process(self, response: LiveResponse) -> LiveResponse | None: ...


class OutputPipeline:
    def __init__(self) -> None:
        self._middlewares: list[OutputMiddleware] = []
        self._executors: list[Callable[[LiveResponse], None]] = []

    def add_middleware(self, middleware: OutputMiddleware) -> OutputPipeline:
        self._middlewares.append(middleware)
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
