from __future__ import annotations

from abc import ABC, abstractmethod

from pydantic import BaseModel

from bellis.core.enums import EmotionEnum, MotionEnum


class Live2DCommand(BaseModel):
    emotion: EmotionEnum | None = None
    motion: MotionEnum | None = None
    duration: float = 1.0
    delay: float = 0.0


class Live2DExecutor(ABC):
    @abstractmethod
    async def drive(self, emotion: EmotionEnum | None, motion: MotionEnum | None, duration: float = 1.0) -> None: ...


class DummyLive2DExecutor(Live2DExecutor):
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
