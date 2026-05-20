"""占位 Live2D 执行器 — 同时实现 Live2DExecutor 和 OutputPlugin 接口。"""

from __future__ import annotations

from bellis.core.actions import Action
from bellis.core.enums import ActionType, EmotionEnum, MotionEnum
from bellis.plugin.base import OutputPlugin, PluginCategory, PluginMeta
from bellis.runtime.executors import Live2DExecutor


class DummyLive2DExecutor(Live2DExecutor, OutputPlugin):
    """占位 Live2D 执行器，同时实现 OutputPlugin 接口。"""

    plugin_meta = PluginMeta(
        name="dummy_live2d",
        version="0.1.0",
        description="占位 Live2D 执行器，不驱动真实模型",
        category=PluginCategory.OUTPUT,
        tags=("live2d", "dummy"),
    )

    def __init__(self) -> None:
        # 直接调用 BasePlugin.__init__，跳过 OutputPlugin 的重复校验
        from bellis.plugin.base import BasePlugin

        base_init = BasePlugin.__init__
        base_init(self)
        self._last_emotion: EmotionEnum | None = None
        self._last_motion: MotionEnum | None = None

    async def drive(self, emotion: EmotionEnum | None, motion: MotionEnum | None, duration: float = 1.0) -> None:
        self._last_emotion = emotion
        self._last_motion = motion

    async def emit(self, action: Action) -> None:
        if action.type == ActionType.set_expression and action.expression:
            try:
                emotion = EmotionEnum(action.expression)
                await self.drive(emotion=emotion, motion=None)
            except ValueError:
                pass
        elif action.type == ActionType.set_motion and action.motion:
            await self.drive(emotion=None, motion=action.motion, duration=action.motion_duration)

    @property
    def last_emotion(self) -> EmotionEnum | None:
        return self._last_emotion

    @property
    def last_motion(self) -> MotionEnum | None:
        return self._last_motion
