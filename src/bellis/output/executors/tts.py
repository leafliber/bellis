from __future__ import annotations

from abc import ABC, abstractmethod

from bellis.core.actions import Action
from bellis.core.enums import ActionType, EmotionEnum
from bellis.core.models import TTSTask
from bellis.plugins.base import OutputPlugin


class TTSExecutor(ABC):
    @abstractmethod
    async def synthesize(self, task: TTSTask) -> bytes | None: ...


class DummyTTSExecutor(TTSExecutor, OutputPlugin):
    """占位 TTS 执行器，同时实现 OutputPlugin 接口。"""

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
