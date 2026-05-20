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
        pass  # 无需额外初始化

    async def _on_stop(self) -> None:
        pass

    async def listen(self) -> AsyncIterator[LiveEvent]:
        import asyncio

        loop = asyncio.get_running_loop()
        while self.state.value == "running":
            try:
                line = await loop.run_in_executor(None, input, "[弹幕] ")
                if line.strip():
                    yield DanmakuEvent(content=line.strip(), user_name="console")
            except (EOFError, KeyboardInterrupt):
                break
