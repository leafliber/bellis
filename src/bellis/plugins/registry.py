from __future__ import annotations

from bellis.plugins.base import HookPlugin, InputPlugin, OutputPlugin, PlatformPlugin, ToolPlugin
from bellis.plugins.hooks import HookManager


class PluginRegistry:
    """显式注册管理所有插件实例。"""

    def __init__(self) -> None:
        self._inputs: list[InputPlugin] = []
        self._outputs: list[OutputPlugin] = []
        self._platforms: list[PlatformPlugin] = []
        self._tools: list[ToolPlugin] = []
        self._hooks: list[HookPlugin] = []
        self._hook_manager: HookManager = HookManager()

    # --- 注册 ---

    def register_input(self, plugin: InputPlugin) -> PluginRegistry:
        self._inputs.append(plugin)
        return self

    def register_output(self, plugin: OutputPlugin) -> PluginRegistry:
        self._outputs.append(plugin)
        return self

    def register_platform(self, plugin: PlatformPlugin) -> PluginRegistry:
        self._platforms.append(plugin)
        return self

    def register_tool(self, plugin: ToolPlugin) -> PluginRegistry:
        self._tools.append(plugin)
        return self

    def register_hook(self, plugin: HookPlugin) -> PluginRegistry:
        self._hooks.append(plugin)
        plugin.register_hooks(self._hook_manager)
        return self

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

    # --- 生命周期 ---

    async def start_inputs(self) -> None:
        for plugin in self._inputs:
            await plugin.start()

    async def stop_inputs(self) -> None:
        for plugin in self._inputs:
            await plugin.stop()

    async def start_platforms(self) -> None:
        for plugin in self._platforms:
            await plugin.start_stream()

    async def stop_platforms(self) -> None:
        for plugin in self._platforms:
            await plugin.stop_stream()
