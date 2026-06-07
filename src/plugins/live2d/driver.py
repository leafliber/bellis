"""WebSocket Live2D 驱动器。

实现 Live2DExecutor 接口，通过 Gateway 广播函数将 Live2D 控制命令
发送到前端，由前端 pixi-live2d-display 执行渲染。
"""

from __future__ import annotations

import logging
from typing import Callable

from bellis.core.enums import EmotionEnum, MotionEnum
from bellis.runtime.executors import Live2DExecutor

from .mappings import EMOTION_MOTION_MAP, MOTION_MOTION_MAP
from .models import Live2DCommand, Live2DCommandType

logger = logging.getLogger(__name__)


class WebSocketLive2DDriver(Live2DExecutor):
    """通过 WebSocket 驱动前端 Live2D 渲染的执行器。

    将高层 drive() 调用翻译为 Live2DCommand 列表，
    通过注入的广播函数发送到前端。

    Attributes:
        _broadcast: 异步广播函数，接收 Live2DCommand 并发送到前端。
    """

    def __init__(self, broadcast_fn: Callable[[Live2DCommand], None]) -> None:
        self._broadcast = broadcast_fn

    async def drive(self, emotion: EmotionEnum | None, motion: MotionEnum | None, duration: float = 1.0) -> None:
        """驱动 Live2D 模型执行表情和动作。

        将情绪和动作分别翻译为 set_emotion + play_motion 命令发送到前端。

        Args:
            emotion: 要表现的情感，为 None 时不改变表情。
            motion: 要执行的动作，为 None 时不触发动作。
            duration: 动作持续时间（秒）。
        """
        if emotion:
            group = EMOTION_MOTION_MAP.get(emotion, "Idle")
            self._broadcast(Live2DCommand(
                type=Live2DCommandType.set_emotion,
                emotion=emotion.value,
                intensity=1.0,
            ))
            self._broadcast(Live2DCommand(
                type=Live2DCommandType.play_motion,
                group=group,
            ))
            logger.debug("Live2D emotion: %s → group %s", emotion.value, group)

        if motion:
            group = MOTION_MOTION_MAP.get(motion, "Idle")
            self._broadcast(Live2DCommand(
                type=Live2DCommandType.play_motion,
                group=group,
            ))
            logger.debug("Live2D motion: %s → group %s", motion.value, group)

    async def send_command(self, command: Live2DCommand) -> None:
        """发送细粒度 Live2D 控制命令到前端。

        Args:
            command: Live2D 控制命令对象。
        """
        self._broadcast(command)
        logger.debug("Live2D command: %s", command.type)
