from __future__ import annotations

from collections.abc import AsyncIterator

from bellis.core.actions import Action
from bellis.core.enums import ActionType
from bellis.core.events import DanmakuEvent, LiveEvent
from bellis.plugins.base import InputPlugin, OutputPlugin


class ConsoleInputPlugin(InputPlugin):
    """终端输入插件，用于调试。输入的文本会被当作弹幕事件。"""

    def __init__(self) -> None:
        self._running = False

    async def start(self) -> None:
        self._running = True

    async def stop(self) -> None:
        self._running = False

    async def listen(self) -> AsyncIterator[LiveEvent]:
        import asyncio

        loop = asyncio.get_event_loop()
        while self._running:
            try:
                line = await loop.run_in_executor(None, input, "[弹幕] ")
                if line.strip():
                    yield DanmakuEvent(content=line.strip(), user_name="console")
            except (EOFError, KeyboardInterrupt):
                self._running = False
                break


class ConsoleOutputPlugin(OutputPlugin):
    """终端输出插件，用于调试。将 Action 打印到控制台。"""

    async def emit(self, action: Action) -> None:
        if action.type == ActionType.speak:
            emotion = f"[{action.emotion.value}]" if action.emotion else ""
            target = f"@{action.target_user} " if action.target_user else ""
            print(f"  说话 {emotion}: {target}{action.text}")
        elif action.type == ActionType.set_expression:
            print(f"  表情: {action.expression}")
        elif action.type == ActionType.set_motion:
            print(f"  动作: {action.motion.value} ({action.motion_duration}s)")
        elif action.type == ActionType.reply_danmaku:
            print(f"  弹幕回复 @{action.target_user}: {action.reply_text}")
        else:
            print(f"  动作({action.type.value}): {action.model_dump(exclude_defaults=True)}")
