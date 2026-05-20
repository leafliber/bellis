"""插件注册表 — 显式注册管理所有插件实例。

本模块提供 PluginRegistry 类，负责按类别（输入、输出、平台、工具、Hook）
管理插件实例的注册、访问与生命周期控制。注册时自动校验插件类别，
启动/停止遵循严格的顺序与逆序原则，确保依赖关系正确。
"""

from __future__ import annotations

import logging

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

logger = logging.getLogger(__name__)


class PluginRegistry:
    """显式注册管理所有插件实例。

    按类别分桶存储插件，注册时自动校验插件类别是否匹配。
    支持链式注册调用，提供统一的启动/停止生命周期管理。

    使用方式::

        registry = PluginRegistry()
        registry.register_input(my_input_plugin)
        registry.register_output(my_output_plugin)
        await registry.start_all()
        ...
        await registry.stop_all()

    Attributes:
        _inputs: 输入插件列表。
        _outputs: 输出插件列表。
        _platforms: 平台插件列表。
        _tools: 工具插件列表。
        _hooks: Hook 插件列表。
        _hook_manager: Hook 管理器，供 HookPlugin 注册 hook 函数。
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
        """注册一个输入插件。

        Args:
            plugin: 输入插件实例，category 必须为 INPUT。

        Returns:
            self，支持链式调用。

        Raises:
            ValueError: 插件类别与 INPUT 不匹配时抛出。
        """
        self._validate(plugin, PluginCategory.INPUT)
        self._inputs.append(plugin)
        return self

    def register_output(self, plugin: OutputPlugin) -> PluginRegistry:
        """注册一个输出插件。

        Args:
            plugin: 输出插件实例，category 必须为 OUTPUT。

        Returns:
            self，支持链式调用。

        Raises:
            ValueError: 插件类别与 OUTPUT 不匹配时抛出。
        """
        self._validate(plugin, PluginCategory.OUTPUT)
        self._outputs.append(plugin)
        return self

    def register_platform(self, plugin: PlatformPlugin) -> PluginRegistry:
        """注册一个平台插件。

        Args:
            plugin: 平台插件实例，category 必须为 PLATFORM。

        Returns:
            self，支持链式调用。

        Raises:
            ValueError: 插件类别与 PLATFORM 不匹配时抛出。
        """
        self._validate(plugin, PluginCategory.PLATFORM)
        self._platforms.append(plugin)
        return self

    def register_tool(self, plugin: ToolPlugin) -> PluginRegistry:
        """注册一个工具插件。

        Args:
            plugin: 工具插件实例，category 必须为 TOOL。

        Returns:
            self，支持链式调用。

        Raises:
            ValueError: 插件类别与 TOOL 不匹配时抛出。
        """
        self._validate(plugin, PluginCategory.TOOL)
        self._tools.append(plugin)
        return self

    def register_hook(self, plugin: HookPlugin) -> PluginRegistry:
        """注册一个 Hook 插件，并自动调用其 register_hooks 方法。

        Args:
            plugin: Hook 插件实例，category 必须为 HOOK。

        Returns:
            self，支持链式调用。

        Raises:
            ValueError: 插件类别与 HOOK 不匹配时抛出。
        """
        self._validate(plugin, PluginCategory.HOOK)
        self._hooks.append(plugin)
        # 让 HookPlugin 自行向 HookManager 注册其 hook 函数
        plugin.register_hooks(self._hook_manager)
        return self

    @staticmethod
    def _validate(plugin: BasePlugin, expected: PluginCategory) -> None:
        """校验插件类别是否与期望值匹配。

        Args:
            plugin: 待校验的插件实例。
            expected: 期望的插件类别。

        Raises:
            ValueError: 插件类别与期望值不匹配时抛出。
        """
        if plugin.plugin_meta.category != expected:
            raise ValueError(
                f"插件 '{plugin.name}' 的 category 为 {plugin.plugin_meta.category}，"
                f"期望 {expected}"
            )

    # --- 访问 ---

    @property
    def inputs(self) -> list[InputPlugin]:
        """返回已注册输入插件的浅拷贝列表。"""
        return list(self._inputs)

    @property
    def outputs(self) -> list[OutputPlugin]:
        """返回已注册输出插件的浅拷贝列表。"""
        return list(self._outputs)

    @property
    def platforms(self) -> list[PlatformPlugin]:
        """返回已注册平台插件的浅拷贝列表。"""
        return list(self._platforms)

    @property
    def tools(self) -> list[ToolPlugin]:
        """返回已注册工具插件的浅拷贝列表。"""
        return list(self._tools)

    @property
    def hook_manager(self) -> HookManager:
        """返回 Hook 管理器实例。"""
        return self._hook_manager

    def collect_tools(self) -> list:
        """收集所有 ToolPlugin 提供的工具函数。

        Returns:
            所有工具插件提供的工具函数列表。
        """
        tools: list = []
        for tp in self._tools:
            tools.extend(tp.get_tools())
        return tools

    def get_all_plugins(self) -> list[BasePlugin]:
        """返回所有已注册的插件实例。

        Returns:
            包含所有类别插件的列表（输入 → 输出 → 平台 → 工具 → Hook）。
        """
        result: list[BasePlugin] = []
        result.extend(self._inputs)
        result.extend(self._outputs)
        result.extend(self._platforms)
        result.extend(self._tools)
        result.extend(self._hooks)
        return result

    # --- 生命周期 ---

    async def start_all(self) -> None:
        """按顺序启动所有插件：输入 → 输出 → 平台 → 工具 → Hook。

        单个插件启动失败不会中断其他插件的启动，仅记录异常日志。
        """
        for plugin in self._inputs:
            try:
                await plugin.start()
                logger.info("插件已启动: %s", plugin.name)
            except Exception:
                logger.exception("插件启动失败: %s", plugin.name)
        for plugin in self._outputs:
            try:
                await plugin.start()
                logger.info("插件已启动: %s", plugin.name)
            except Exception:
                logger.exception("插件启动失败: %s", plugin.name)
        for plugin in self._platforms:
            try:
                await plugin.start()
                logger.info("插件已启动: %s", plugin.name)
            except Exception:
                logger.exception("插件启动失败: %s", plugin.name)
        for plugin in self._tools:
            try:
                await plugin.start()
                logger.info("插件已启动: %s", plugin.name)
            except Exception:
                logger.exception("插件启动失败: %s", plugin.name)
        for plugin in self._hooks:
            try:
                await plugin.start()
                logger.info("插件已启动: %s", plugin.name)
            except Exception:
                logger.exception("插件启动失败: %s", plugin.name)

    async def stop_all(self) -> None:
        """按逆序停止所有插件：Hook → 工具 → 平台 → 输出 → 输入。

        停止顺序与启动顺序相反，确保依赖关系正确释放。
        单个插件停止失败不会中断其他插件的停止，仅记录异常日志。
        """
        for plugin in self._hooks:
            try:
                await plugin.stop()
            except Exception:
                logger.exception("插件停止失败: %s", plugin.name)
        for plugin in self._tools:
            try:
                await plugin.stop()
            except Exception:
                logger.exception("插件停止失败: %s", plugin.name)
        for plugin in self._platforms:
            try:
                await plugin.stop()
            except Exception:
                logger.exception("插件停止失败: %s", plugin.name)
        for plugin in self._outputs:
            try:
                await plugin.stop()
            except Exception:
                logger.exception("插件停止失败: %s", plugin.name)
        for plugin in self._inputs:
            try:
                await plugin.stop()
            except Exception:
                logger.exception("插件停止失败: %s", plugin.name)

    async def start_inputs(self) -> None:
        """仅启动所有输入插件。

        与 start_all 不同，此方法不捕获异常，启动失败会向上传播。
        """
        for plugin in self._inputs:
            await plugin.start()

    async def stop_inputs(self) -> None:
        """仅停止所有输入插件。

        与 stop_all 不同，此方法不捕获异常，停止失败会向上传播。
        """
        for plugin in self._inputs:
            await plugin.stop()

    async def start_platforms(self) -> None:
        """仅启动所有平台插件。

        与 start_all 不同，此方法不捕获异常，启动失败会向上传播。
        """
        for plugin in self._platforms:
            await plugin.start()

    async def stop_platforms(self) -> None:
        """仅停止所有平台插件。

        与 stop_all 不同，此方法不捕获异常，停止失败会向上传播。
        """
        for plugin in self._platforms:
            await plugin.stop()
