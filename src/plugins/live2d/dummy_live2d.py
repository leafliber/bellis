"""占位 Live2D 执行器 — 实现 OutputPlugin 接口，内部组合 Live2DExecutor。"""

from __future__ import annotations

from bellis.core.actions import Action
from bellis.core.enums import ActionType, EmotionEnum, MotionEnum
from bellis.plugin.base import OutputPlugin, PluginCategory, PluginMeta
from bellis.runtime.executors import Live2DExecutor


class _DummyLive2DDriver(Live2DExecutor):
    """Live2DExecutor 的占位实现，不驱动真实模型。"""

    def __init__(self) -> None:
        self._last_emotion: EmotionEnum | None = None
        self._last_motion: MotionEnum | None = None

    async def drive(self, emotion: EmotionEnum | None, motion: MotionEnum | None, duration: float = 1.0) -> None:
        self._last_emotion = emotion
        self._last_motion = motion

    @property
    def last_emotion(self) -> EmotionEnum | None:
        return self._last_emotion

    @property
    def last_motion(self) -> MotionEnum | None:
        return self._last_motion


class DummyLive2DExecutor(OutputPlugin):
    """占位 Live2D 输出插件，通过组合方式持有 Live2DExecutor 驱动器。"""

    plugin_meta = PluginMeta(
        name="dummy_live2d",
        version="0.1.0",
        description="占位 Live2D 执行器，不驱动真实模型",
        category=PluginCategory.OUTPUT,
        tags=("live2d", "dummy"),
    )

    def __init__(self) -> None:
        super().__init__()
        self._driver = _DummyLive2DDriver()

    @property
    def driver(self) -> _DummyLive2DDriver:
        """暴露底层驱动器，供 TimelineSync 等组件直接使用。"""
        return self._driver

    async def emit(self, action: Action) -> None:
        if action.type == ActionType.set_expression and action.expression:
            try:
                emotion = EmotionEnum(action.expression)
                await self._driver.drive(emotion=emotion, motion=None)
            except ValueError:
                pass
        elif action.type == ActionType.set_motion and action.motion:
            await self._driver.drive(emotion=None, motion=action.motion, duration=action.motion_duration)

    @property
    def last_emotion(self) -> EmotionEnum | None:
        return self._driver.last_emotion

    @property
    def last_motion(self) -> MotionEnum | None:
        return self._driver.last_motion
