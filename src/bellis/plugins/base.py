from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator

from bellis.core.actions import Action
from bellis.core.events import LiveEvent
from bellis.plugins.hooks import HookManager


class InputPlugin(ABC):
    """产生输入事件流。"""

    @abstractmethod
    async def listen(self) -> AsyncIterator[LiveEvent]: ...

    @abstractmethod
    async def start(self) -> None: ...

    @abstractmethod
    async def stop(self) -> None: ...


class OutputPlugin(ABC):
    """消费输出动作。"""

    @abstractmethod
    async def emit(self, action: Action) -> None: ...


class PlatformPlugin(ABC):
    """平台控制（开播/关播/房间信息）。"""

    @abstractmethod
    async def start_stream(self) -> None: ...

    @abstractmethod
    async def stop_stream(self) -> None: ...

    @abstractmethod
    async def get_room_info(self) -> dict: ...


class ToolPlugin(ABC):
    """为 Think Agent 提供工具。"""

    @abstractmethod
    def get_tools(self) -> list:
        """返回 PydanticAI 兼容的工具函数列表。"""
        ...


class HookPlugin(ABC):
    """注册 hook 到主循环。"""

    @abstractmethod
    def register_hooks(self, hook_mgr: HookManager) -> None: ...
