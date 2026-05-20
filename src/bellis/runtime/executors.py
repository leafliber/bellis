"""执行器抽象基类定义。

定义 TTS 和 Live2D 的执行器接口，具体实现由插件模块提供。
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from bellis.core.enums import EmotionEnum, MotionEnum
from bellis.core.models import TTSTask


class TTSExecutor(ABC):
    """TTS 执行器抽象基类。具体实现放在 src/plugins/ 中。"""

    @abstractmethod
    async def synthesize(self, task: TTSTask) -> bytes | None:
        """将文本合成为语音数据。

        Args:
            task: TTS 合成任务，包含文本、语速、情感等信息。

        Returns:
            合成后的音频字节数据，合成失败时返回 None。
        """
        ...


class Live2DExecutor(ABC):
    """Live2D 执行器抽象基类。具体实现放在 src/plugins/ 中。"""

    @abstractmethod
    async def drive(self, emotion: EmotionEnum | None, motion: MotionEnum | None, duration: float = 1.0) -> None:
        """驱动 Live2D 模型执行表情和动作。

        Args:
            emotion: 要表现的情感，为 None 时不改变表情。
            motion: 要执行的动作，为 None 时不触发动作。
            duration: 动作持续时间（秒），默认 1.0 秒。
        """
        ...
