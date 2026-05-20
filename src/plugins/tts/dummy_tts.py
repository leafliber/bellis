"""占位 TTS 执行器 — 同时实现 TTSExecutor 和 OutputPlugin 接口。"""

from __future__ import annotations

from bellis.core.actions import Action
from bellis.core.enums import ActionType, EmotionEnum
from bellis.core.models import TTSTask
from bellis.plugin.base import OutputPlugin, PluginCategory, PluginMeta
from bellis.runtime.executors import TTSExecutor


class DummyTTSExecutor(TTSExecutor, OutputPlugin):
    """占位 TTS 执行器，同时实现 OutputPlugin 接口。"""

    plugin_meta = PluginMeta(
        name="dummy_tts",
        version="0.1.0",
        description="占位 TTS 执行器，不产生实际语音",
        category=PluginCategory.OUTPUT,
        tags=("tts", "dummy"),
    )

    async def synthesize(self, task: TTSTask) -> bytes | None:
        return b""

    async def emit(self, action: Action) -> None:
        if action.type == ActionType.speak and action.text:
            task = TTSTask(
                text=action.text,
                speed=action.tts_speed,
                emotion=action.emotion or EmotionEnum.neutral,
                target_user=action.target_user,
                priority=action.priority,
            )
            await self.synthesize(task)
