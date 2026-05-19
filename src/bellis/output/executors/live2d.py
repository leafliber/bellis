from __future__ import annotations

from abc import ABC, abstractmethod

from pydantic import BaseModel

from bellis.core.actions import Action
from bellis.core.enums import ActionType, EmotionEnum, MotionEnum
from bellis.plugins.base import OutputPlugin


class Live2DCommand(BaseModel):
    emotion: EmotionEnum | None = None
    motion: MotionEnum | None = None
    duration: float = 1.0
    delay: float = 0.0


class Live2DExecutor(ABC):
    @abstractmethod
    async def drive(self, emotion: EmotionEnum | None, motion: MotionEnum | None, duration: float = 1.0) -> None: ...


class DummyLive2DExecutor(Live2DExecutor, OutputPlugin):
    """占位 Live2D 执行器，同时实现 OutputPlugin 接口。"""

    def __init__(self) -> None:
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
