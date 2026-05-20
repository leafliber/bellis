"""插件接口基类 — 所有插件必须继承这些 ABC 并实现其抽象方法。

设计原则：
1. 每个插件必须提供 ``plugin_meta`` 属性（名称、版本、描述）
2. 生命周期由 ``start`` / ``stop`` 统一管理，框架保证调用顺序
3. 插件注册时自动校验元数据完整性
4. 具体插件实现放在 ``src/plugins/`` 目录，本文件只定义接口约束
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

# ─── 插件元数据 ──────────────────────────────────────────────────────


class PluginCategory(StrEnum):
    """插件类别，与五类 Plugin ABC 一一对应。"""
    INPUT = "input"
    OUTPUT = "output"
    PLATFORM = "platform"
    TOOL = "tool"
    HOOK = "hook"


@dataclass(frozen=True)
class PluginMeta:
    """插件元数据 — 每个插件必须通过 ``plugin_meta`` 类属性声明。"""

    name: str
    version: str = "0.1.0"
    description: str = ""
    category: PluginCategory = PluginCategory.INPUT
    tags: tuple[str, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        if not self.name.strip():
            raise ValueError("PluginMeta.name 不能为空")
        if not self.version.strip():
            raise ValueError("PluginMeta.version 不能为空")


# ─── 插件生命周期状态 ────────────────────────────────────────────────


class PluginState(StrEnum):
    CREATED = "created"
    STARTING = "starting"
    RUNNING = "running"
    STOPPING = "stopping"
    STOPPED = "stopped"
    ERROR = "error"


# ─── 插件基类 ────────────────────────────────────────────────────────


class BasePlugin(ABC):
    """所有插件的公共基类，提供元数据、生命周期状态和模板方法。"""

    # 子类必须覆盖此属性
    plugin_meta: PluginMeta

    def __init__(self) -> None:
        if not hasattr(self, "plugin_meta") or not isinstance(self.plugin_meta, PluginMeta):
            raise TypeError(
                f"{type(self).__name__} 必须定义 plugin_meta 类属性 (PluginMeta 实例)"
            )
        self._state: PluginState = PluginState.CREATED

    @property
    def state(self) -> PluginState:
        return self._state

    @property
    def name(self) -> str:
        return self.plugin_meta.name

    async def start(self) -> None:
        """启动插件。子类可覆盖 ``_on_start`` 添加自定义逻辑。"""
        if self._state == PluginState.RUNNING:
            return
        if self._state not in (PluginState.CREATED, PluginState.STOPPED, PluginState.ERROR):
            raise RuntimeError(f"插件 {self.name} 处于 {self._state} 状态，无法启动")
        self._state = PluginState.STARTING
        try:
            await self._on_start()
            self._state = PluginState.RUNNING
        except Exception:
            self._state = PluginState.ERROR
            raise

    async def stop(self) -> None:
        """停止插件。子类可覆盖 ``_on_stop`` 添加自定义逻辑。"""
        if self._state in (PluginState.STOPPED, PluginState.CREATED):
            return
        self._state = PluginState.STOPPING
        try:
            await self._on_stop()
        except Exception:
            import logging
            logging.getLogger(__name__).warning("插件 %s 停止时发生异常", self.name, exc_info=True)
        finally:
            self._state = PluginState.STOPPED

    async def _on_start(self) -> None:
        """子类覆盖此方法实现启动逻辑。"""

    async def _on_stop(self) -> None:
        """子类覆盖此方法实现停止逻辑。"""


# ─── 五类插件接口 ────────────────────────────────────────────────────


class InputPlugin(BasePlugin):
    """产生输入事件流。

    子类必须：
    1. 定义 ``plugin_meta`` 且 ``category=PluginCategory.INPUT``
    2. 实现 ``listen()`` 方法，返回 AsyncIterator[LiveEvent]
    3. 可选覆盖 ``_on_start`` / ``_on_stop`` 管理连接生命周期
    """

    def __init__(self) -> None:
        super().__init__()
        if self.plugin_meta.category != PluginCategory.INPUT:
            raise ValueError(
                f"InputPlugin '{self.name}' 的 category 必须是 PluginCategory.INPUT，"
                f"当前为 {self.plugin_meta.category}"
            )

    @abstractmethod
    async def listen(self) -> AsyncIterator[Any]:
        """产生输入事件流。框架会持续迭代此迭代器获取事件。"""


class OutputPlugin(BasePlugin):
    """消费输出动作。

    子类必须：
    1. 定义 ``plugin_meta`` 且 ``category=PluginCategory.OUTPUT``
    2. 实现 ``emit()`` 方法，处理 Action 对象
    """

    def __init__(self) -> None:
        super().__init__()
        if self.plugin_meta.category != PluginCategory.OUTPUT:
            raise ValueError(
                f"OutputPlugin '{self.name}' 的 category 必须是 PluginCategory.OUTPUT，"
                f"当前为 {self.plugin_meta.category}"
            )

    @abstractmethod
    async def emit(self, action: Any) -> None:
        """消费一个 Action 对象。"""


class PlatformPlugin(BasePlugin):
    """平台控制（开播/关播/房间信息）。

    子类必须：
    1. 定义 ``plugin_meta`` 且 ``category=PluginCategory.PLATFORM``
    2. 实现 ``start_stream`` / ``stop_stream`` / ``get_room_info``
    """

    def __init__(self) -> None:
        super().__init__()
        if self.plugin_meta.category != PluginCategory.PLATFORM:
            raise ValueError(
                f"PlatformPlugin '{self.name}' 的 category 必须是 PluginCategory.PLATFORM，"
                f"当前为 {self.plugin_meta.category}"
            )

    @abstractmethod
    async def start_stream(self) -> None: ...

    @abstractmethod
    async def stop_stream(self) -> None: ...

    @abstractmethod
    async def get_room_info(self) -> dict: ...

    async def _on_start(self) -> None:
        await self.start_stream()

    async def _on_stop(self) -> None:
        await self.stop_stream()


class ToolPlugin(BasePlugin):
    """为 Think Agent 提供工具。

    子类必须：
    1. 定义 ``plugin_meta`` 且 ``category=PluginCategory.TOOL``
    2. 实现 ``get_tools()`` 方法，返回 PydanticAI 兼容的工具函数列表
    """

    def __init__(self) -> None:
        super().__init__()
        if self.plugin_meta.category != PluginCategory.TOOL:
            raise ValueError(
                f"ToolPlugin '{self.name}' 的 category 必须是 PluginCategory.TOOL，"
                f"当前为 {self.plugin_meta.category}"
            )

    @abstractmethod
    def get_tools(self) -> list:
        """返回 PydanticAI 兼容的工具函数列表。"""


class HookPlugin(BasePlugin):
    """注册 hook 到主循环。

    子类必须：
    1. 定义 ``plugin_meta`` 且 ``category=PluginCategory.HOOK``
    2. 实现 ``register_hooks()`` 方法
    """

    def __init__(self) -> None:
        super().__init__()
        if self.plugin_meta.category != PluginCategory.HOOK:
            raise ValueError(
                f"HookPlugin '{self.name}' 的 category 必须是 PluginCategory.HOOK，"
                f"当前为 {self.plugin_meta.category}"
            )

    @abstractmethod
    def register_hooks(self, hook_mgr: Any) -> None:
        """将 hook 函数注册到 HookManager。"""
