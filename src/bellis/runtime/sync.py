from __future__ import annotations

import asyncio
import logging

from bellis.core.enums import EmotionEnum, MotionEnum
from bellis.core.models import TTSTask
from bellis.core.response import LiveResponse
from bellis.runtime.executors import Live2DExecutor, TTSExecutor

logger = logging.getLogger(__name__)

MOTION_LEAD_TIME = 0.3


class TimelineSync:
    """TTS 与 Live2D 时间轴同步播放器。

    通过组合方式持有 TTSExecutor 和 Live2DExecutor 实例，
    可从 DummyTTSExecutor.driver / DummyLive2DExecutor.driver 获取。
    """

    def __init__(self, tts: TTSExecutor, live2d: Live2DExecutor) -> None:
        self._tts = tts
        self._live2d = live2d

    async def sync_play(self, response: LiveResponse) -> None:
        motion_task = asyncio.create_task(
            self._trigger_motion(response.motion, response.emotion, response.motion_duration)
        )
        tts_task = asyncio.create_task(self._play_tts(response))
        results = await asyncio.gather(motion_task, tts_task, return_exceptions=True)
        for result in results:
            if isinstance(result, Exception):
                logger.warning("sync_play 任务异常: %s", result)

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
