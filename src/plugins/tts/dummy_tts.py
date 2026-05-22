"""占位 TTS 执行器 — 实现 OutputPlugin 接口，内部组合 TTSExecutor。

TODO: 替换为真实 TTS 驱动实现（如 Edge-TTS、VITS 等）。
"""

from __future__ import annotations

from bellis.core.actions import Action
from bellis.core.enums import ActionType, EmotionEnum
from bellis.core.models import TTSTask
from bellis.plugin.base import OutputPlugin, PluginCategory, PluginMeta
from bellis.runtime.executors import TTSExecutor


class _DummyTTSDriver(TTSExecutor):
    """TTSExecutor 的占位实现，不产生实际语音。

    合成方法始终返回空字节串，用于测试和开发环境。
    """

    async def synthesize(self, task: TTSTask) -> bytes | None:
        """占位合成方法，返回空字节串。

        Args:
            task: TTS 合成任务，包含文本、语速、情绪等参数。

        Returns:
            空字节串 ``b""``。
        """
        return b""


class DummyTTSExecutor(OutputPlugin):
    """占位 TTS 输出插件，通过组合方式持有 TTSExecutor 驱动器。

    Attributes:
        _driver: 内部持有的占位 TTS 驱动器实例。
    """

    plugin_meta = PluginMeta(
        name="dummy_tts",
        version="0.1.0",
        description="占位 TTS 执行器，不产生实际语音",
        category=PluginCategory.OUTPUT,
        tags=("tts", "dummy"),
    )

    def __init__(self) -> None:
        """初始化占位 TTS 执行器，创建内部驱动器。"""
        super().__init__()
        self._driver = _DummyTTSDriver()

    @property
    def driver(self) -> _DummyTTSDriver:
        """暴露底层驱动器，供 TimelineSync 等组件直接使用。"""
        return self._driver

    async def emit(self, action: Action) -> None:
        """根据 Action 类型执行 TTS 合成（占位实现不产生实际语音）。

        仅处理 speak 类型动作，将文本、语速、情绪等参数构造为
        TTSTask 后交由驱动器合成。

        Args:
            action: 待执行的动作对象。
        """
        if action.type == ActionType.speak and action.text:
            task = TTSTask(
                text=action.text,
                speed=action.tts_speed,
                emotion=action.emotion or EmotionEnum.neutral,
                target_user=action.target_user,
                priority=action.priority,
            )
            await self._driver.synthesize(task)
