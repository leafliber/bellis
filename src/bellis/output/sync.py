from __future__ import annotations

import asyncio

from bellis.core.enums import EmotionEnum, MotionEnum
from bellis.core.models import TTSTask
from bellis.core.response import LiveResponse
from bellis.output.executors.live2d import Live2DExecutor
from bellis.output.executors.tts import TTSExecutor

MOTION_LEAD_TIME = 0.3


class TimelineSync:
    def __init__(self, tts: TTSExecutor, live2d: Live2DExecutor) -> None:
        self._tts = tts
        self._live2d = live2d

    async def sync_play(self, response: LiveResponse) -> None:
        motion_task = asyncio.create_task(
            self._trigger_motion(response.motion, response.emotion, response.motion_duration)
        )
        tts_task = asyncio.create_task(self._play_tts(response))
        await asyncio.gather(motion_task, tts_task)

    async def _trigger_motion(self, motion: MotionEnum, emotion: EmotionEnum, duration: float) -> None:
        await asyncio.sleep(MOTION_LEAD_TIME)
        await self._live2d.drive(emotion=emotion, motion=motion, duration=duration)

    async def _play_tts(self, response: LiveResponse) -> None:
        task = TTSTask(
            text=response.text,
            speed=response.tts_speed,
            emotion=response.emotion,
            target_user=response.target_user,
            priority=response.priority,
        )
        await self._tts.synthesize(task)
