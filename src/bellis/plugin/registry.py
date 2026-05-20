"""插件注册表 — 显式注册管理所有插件实例。"""

from __future__ import annotations

from bellis.plugin.base import (
    BasePlugin,
    HookPlugin,
    InputPlugin,
    OutputPlugin,
    PlatformPlugin,
    PluginCategory,
    ToolPlugin,
)
from bellis.plugin.hooks import HookManager


class PluginRegistry:
    """显式注册管理所有插件实例。

    使用方式::

        registry = PluginRegistry()
        registry.register_input(my_input_plugin)
        registry.register_output(my_output_plugin)
        await registry.start_all()
        ...
        await registry.stop_all()
    """

    def __init__(self) -> None:
        self._inputs: list[InputPlugin] = []
        self._outputs: list[OutputPlugin] = []
        self._platforms: list[PlatformPlugin] = []
        self._tools: list[ToolPlugin] = []
        self._hooks: list[HookPlugin] = []
        self._hook_manager: HookManager = HookManager()

    # --- 注册（带类型校验）---

    def register_input(self, plugin: InputPlugin) -> PluginRegistry:
        self._validate(plugin, PluginCategory.INPUT)
        self._inputs.append(plugin)
        return self

    def register_output(self, plugin: OutputPlugin) -> PluginRegistry:
        self._validate(plugin, PluginCategory.OUTPUT)
        self._outputs.append(plugin)
        return self

    def register_platform(self, plugin: PlatformPlugin) -> PluginRegistry:
        self._validate(plugin, PluginCategory.PLATFORM)
        self._platforms.append(plugin)
        return self

    def register_tool(self, plugin: ToolPlugin) -> PluginRegistry:
        self._validate(plugin, PluginCategory.TOOL)
        self._tools.append(plugin)
        return self

    def register_hook(self, plugin: HookPlugin) -> PluginRegistry:
        self._validate(plugin, PluginCategory.HOOK)
        self._hooks.append(plugin)
        plugin.register_hooks(self._hook_manager)
        return self

    @staticmethod
    def _validate(plugin: BasePlugin, expected: PluginCategory) -> None:
        if plugin.plugin_meta.category != expected:
            raise ValueError(
                f"插件 '{plugin.name}' 的 category 为 {plugin.plugin_meta.category}，"
                f"期望 {expected}"
            )

    # --- 访问 ---

    @property
    def inputs(self) -> list[InputPlugin]:
        return list(self._inputs)

    @property
    def outputs(self) -> list[OutputPlugin]:
        return list(self._outputs)

    @property
    def platforms(self) -> list[PlatformPlugin]:
        return list(self._platforms)

    @property
    def tools(self) -> list[ToolPlugin]:
        return list(self._tools)

    @property
    def hook_manager(self) -> HookManager:
        return self._hook_manager

    def collect_tools(self) -> list:
        """收集所有 ToolPlugin 提供的工具函数。"""
        tools: list = []
        for tp in self._tools:
            tools.extend(tp.get_tools())
        return tools

    def get_all_plugins(self) -> list[BasePlugin]:
        """返回所有已注册的插件实例。"""
        result: list[BasePlugin] = []
        result.extend(self._inputs)
        result.extend(self._outputs)
        result.extend(self._platforms)
        result.extend(self._tools)
        result.extend(self._hooks)
        return result

    # --- 生命周期 ---

    async def start_all(self) -> None:
        """按顺序启动所有插件：输入 → 输出 → 平台 → 工具 → Hook。"""
        for plugin in self._inputs:
            await plugin.start()
        for plugin in self._outputs:
            await plugin.start()
        for plugin in self._platforms:
            await plugin.start()
        for plugin in self._tools:
            await plugin.start()
        for plugin in self._hooks:
            await plugin.start()

    async def stop_all(self) -> None:
        """按逆序停止所有插件：Hook → 工具 → 平台 → 输出 → 输入。"""
        for plugin in self._hooks:
            await plugin.stop()
        for plugin in self._tools:
            await plugin.stop()
        for plugin in self._platforms:
            await plugin.stop()
        for plugin in self._outputs:
            await plugin.stop()
        for plugin in self._inputs:
            await plugin.stop()

    async def start_inputs(self) -> None:
        for plugin in self._inputs:
            await plugin.start()

    async def stop_inputs(self) -> None:
        for plugin in self._inputs:
            await plugin.stop()

    async def start_platforms(self) -> None:
        for plugin in self._platforms:
            await plugin.start()

    async def stop_platforms(self) -> None:
        for plugin in self._platforms:
            await plugin.stop()
