from __future__ import annotations

from abc import ABC, abstractmethod

from pydantic import BaseModel

from bellis.core.enums import EmotionEnum, MotionEnum
from bellis.core.models import TTSTask


class TTSExecutor(ABC):
    """TTS 执行器抽象基类。具体实现放在 src/plugins/ 中。"""

    @abstractmethod
    async def synthesize(self, task: TTSTask) -> bytes | None: ...


class Live2DCommand(BaseModel):
    emotion: EmotionEnum | None = None
    motion: MotionEnum | None = None
    duration: float = 1.0
    delay: float = 0.0


class Live2DExecutor(ABC):
    """Live2D 执行器抽象基类。具体实现放在 src/plugins/ 中。"""

    @abstractmethod
    async def drive(self, emotion: EmotionEnum | None, motion: MotionEnum | None, duration: float = 1.0) -> None: ...
