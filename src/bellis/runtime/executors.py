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

    async def send_command(self, command: object) -> None:
        """发送细粒度 Live2D 控制命令。

        子类可覆盖此方法以支持更细粒度的模型参数控制。
        默认实现将 set_emotion 类型命令委托给 drive() 方法，
        其他类型命令不做处理（需要子类自行实现）。

        Args:
            command: Live2D 控制命令对象，具体类型由插件定义。
        """
        # 默认实现：尝试从命令对象中提取情绪信息
        if hasattr(command, "type") and hasattr(command, "emotion"):
            if getattr(command, "type", None) == "set_emotion" and getattr(command, "emotion", None):
                try:
                    emotion = EmotionEnum(getattr(command, "emotion"))
                    await self.drive(emotion=emotion, motion=None)
                except ValueError:
                    pass
