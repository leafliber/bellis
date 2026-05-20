"""bellis.plugin — 插件接口与注册机制。

本包只定义插件 ABC 和管理工具，具体插件实现放在 ``src/plugins/`` 目录。
"""

from bellis.plugin.base import (
    BasePlugin,
    HookPlugin,
    InputPlugin,
    OutputPlugin,
    PlatformPlugin,
    PluginCategory,
    PluginMeta,
    PluginState,
    ToolPlugin,
)
from bellis.plugin.hooks import HOOK_POINTS, HookManager
from bellis.plugin.registry import PluginRegistry

__all__ = [
    # 元数据
    "PluginMeta",
    "PluginCategory",
    "PluginState",
    # 基类
    "BasePlugin",
    # 五类插件接口
    "InputPlugin",
    "OutputPlugin",
    "PlatformPlugin",
    "ToolPlugin",
    "HookPlugin",
    # 管理工具
    "HookManager",
    "HOOK_POINTS",
    "PluginRegistry",
]
