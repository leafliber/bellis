"""终端输入插件 — 从 stdin 读取弹幕，用于调试。"""

from __future__ import annotations

from collections.abc import AsyncIterator

from bellis.core.events import DanmakuEvent, LiveEvent
from bellis.plugin.base import InputPlugin, PluginCategory, PluginMeta


class ConsoleInputPlugin(InputPlugin):
    """终端输入插件，输入的文本会被当作弹幕事件。"""

    plugin_meta = PluginMeta(
        name="console_input",
        version="0.1.0",
        description="终端输入插件，从 stdin 读取弹幕",
        category=PluginCategory.INPUT,
        tags=("debug", "console"),
    )

    async def _on_start(self) -> None:
        """插件启动（终端输入无需额外初始化）。"""
        pass  # 无需额外初始化

    async def _on_stop(self) -> None:
        """插件停止（终端输入无需额外清理）。"""
        pass

    async def listen(self) -> AsyncIterator[LiveEvent]:
        """从 stdin 逐行读取输入，包装为 DanmakuEvent 产出。

        使用 ``run_in_executor`` 将阻塞的 ``input()`` 调用移至线程池，
        避免阻塞事件循环。输入为空行时跳过，遇到 EOF 或 Ctrl+C 时退出。

        Yields:
            LiveEvent: 以终端输入内容构造的 DanmakuEvent，user_name 固定为 "console"。
        """
        import asyncio

        loop = asyncio.get_running_loop()
        while self.state.value == "running":
            try:
                line = await loop.run_in_executor(None, input, "[弹幕] ")
                if line.strip():
                    yield DanmakuEvent(content=line.strip(), user_name="console")
            except (EOFError, KeyboardInterrupt):
                break
