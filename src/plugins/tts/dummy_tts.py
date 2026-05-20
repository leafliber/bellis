"""占位 TTS 执行器 — 实现 OutputPlugin 接口，内部组合 TTSExecutor。"""

from __future__ import annotations

from bellis.core.actions import Action
from bellis.core.enums import ActionType, EmotionEnum
from bellis.core.models import TTSTask
from bellis.plugin.base import OutputPlugin, PluginCategory, PluginMeta
from bellis.runtime.executors import TTSExecutor


class _DummyTTSDriver(TTSExecutor):
    """TTSExecutor 的占位实现，不产生实际语音。"""

    async def synthesize(self, task: TTSTask) -> bytes | None:
        return b""


class DummyTTSExecutor(OutputPlugin):
    """占位 TTS 输出插件，通过组合方式持有 TTSExecutor 驱动器。"""

    plugin_meta = PluginMeta(
        name="dummy_tts",
        version="0.1.0",
        description="占位 TTS 执行器，不产生实际语音",
        category=PluginCategory.OUTPUT,
        tags=("tts", "dummy"),
    )

    def __init__(self) -> None:
        super().__init__()
        self._driver = _DummyTTSDriver()

    @property
    def driver(self) -> _DummyTTSDriver:
        """暴露底层驱动器，供 TimelineSync 等组件直接使用。"""
        return self._driver

    async def emit(self, action: Action) -> None:
        if action.type == ActionType.speak and action.text:
            task = TTSTask(
                text=action.text,
                speed=action.tts_speed,
                emotion=action.emotion or EmotionEnum.neutral,
                target_user=action.target_user,
                priority=action.priority,
            )
            await self._driver.synthesize(task)
