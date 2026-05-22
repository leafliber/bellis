"""TTS 与 Live2D 时间轴同步播放模块。

协调语音合成和虚拟形象动作的并行执行，
确保动作略早于语音触发以实现自然的视听同步。
"""

from __future__ import annotations

import asyncio
import logging

from bellis.core.enums import EmotionEnum, MotionEnum
from bellis.core.models import TTSTask
from bellis.core.response import LiveResponse
from bellis.runtime.executors import Live2DExecutor, TTSExecutor

logger = logging.getLogger(__name__)

# 动作提前触发时间（秒），使表情/动作先于语音开始，提升观感自然度
MOTION_LEAD_TIME = 0.3


class TimelineSync:
    """TTS 与 Live2D 时间轴同步播放器。

    通过组合方式持有 TTSExecutor 和 Live2DExecutor 实例，
    可从 TTSPlugin.driver / Live2D 插件的 driver 属性获取。
    """

    def __init__(self, tts: TTSExecutor, live2d: Live2DExecutor) -> None:
        """初始化同步播放器。

        Args:
            tts: TTS 执行器实例，负责语音合成。
            live2d: Live2D 执行器实例，负责虚拟形象驱动。
        """
        self._tts = tts
        self._live2d = live2d

    async def sync_play(self, response: LiveResponse) -> None:
        """同步播放响应：并行触发动作和 TTS，并收集异常。

        动作会提前 MOTION_LEAD_TIME 秒触发，两个任务并行执行，
        任一任务异常不会中断另一任务，仅记录警告日志。

        Args:
            response: 包含文本、情感、动作等信息的直播响应。
        """
        motion_task = asyncio.create_task(
            self._trigger_motion(response.motion, response.emotion, response.motion_duration)
        )
        tts_task = asyncio.create_task(self._play_tts(response))
        results = await asyncio.gather(motion_task, tts_task, return_exceptions=True)
        for result in results:
            if isinstance(result, Exception):
                logger.warning("sync_play 任务异常: %s", result)

    async def _trigger_motion(self, motion: MotionEnum, emotion: EmotionEnum, duration: float) -> None:
        """延迟后触发 Live2D 动作和表情。

        Args:
            motion: 要执行的动作枚举值。
            emotion: 要表现的情感枚举值。
            duration: 动作持续时间（秒）。
        """
        await asyncio.sleep(MOTION_LEAD_TIME)  # 提前量，让动作先于语音启动
        await self._live2d.drive(emotion=emotion, motion=motion, duration=duration)

    async def _play_tts(self, response: LiveResponse) -> None:
        """将响应文本提交给 TTS 执行器进行语音合成。

        Args:
            response: 包含文本、语速、情感等信息的直播响应。
        """
        task = TTSTask(
            text=response.text,
            speed=response.tts_speed,
            emotion=response.emotion,
            target_user=response.target_user,
            priority=response.priority,
        )
        await self._tts.synthesize(task)
