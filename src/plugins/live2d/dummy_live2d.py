"""占位 Live2D 执行器 — 实现 OutputPlugin 接口，内部组合 Live2DExecutor。"""

from __future__ import annotations

from bellis.core.actions import Action
from bellis.core.enums import ActionType, EmotionEnum, MotionEnum
from bellis.plugin.base import OutputPlugin, PluginCategory, PluginMeta
from bellis.runtime.executors import Live2DExecutor


class _DummyLive2DDriver(Live2DExecutor):
    """Live2DExecutor 的占位实现，不驱动真实模型。

    Attributes:
        _last_emotion: 最近一次设置的情绪。
        _last_motion: 最近一次设置的动作。
    """

    def __init__(self) -> None:
        self._last_emotion: EmotionEnum | None = None
        self._last_motion: MotionEnum | None = None

    async def drive(self, emotion: EmotionEnum | None, motion: MotionEnum | None, duration: float = 1.0) -> None:
        """记录情绪和动作，不驱动真实 Live2D 模型。

        Args:
            emotion: 要设置的情绪枚举值，可为 None。
            motion: 要设置的动作枚举值，可为 None。
            duration: 动作持续时间（秒），占位实现中未使用。
        """
        self._last_emotion = emotion
        self._last_motion = motion

    @property
    def last_emotion(self) -> EmotionEnum | None:
        """最近一次设置的情绪。"""
        return self._last_emotion

    @property
    def last_motion(self) -> MotionEnum | None:
        """最近一次设置的动作。"""
        return self._last_motion


class DummyLive2DExecutor(OutputPlugin):
    """占位 Live2D 输出插件，通过组合方式持有 Live2DExecutor 驱动器。

    Attributes:
        _driver: 内部持有的占位 Live2D 驱动器实例。
    """

    plugin_meta = PluginMeta(
        name="dummy_live2d",
        version="0.1.0",
        description="占位 Live2D 执行器，不驱动真实模型",
        category=PluginCategory.OUTPUT,
        tags=("live2d", "dummy"),
    )

    def __init__(self) -> None:
        """初始化占位 Live2D 执行器，创建内部驱动器。"""
        super().__init__()
        self._driver = _DummyLive2DDriver()

    @property
    def driver(self) -> _DummyLive2DDriver:
        """暴露底层驱动器，供 TimelineSync 等组件直接使用。"""
        return self._driver

    async def emit(self, action: Action) -> None:
        """根据 Action 类型驱动 Live2D 模型（占位实现仅记录状态）。

        处理 set_expression 和 set_motion 两种动作类型：
        - set_expression: 将 expression 字符串转为 EmotionEnum 后驱动
        - set_motion: 直接使用 motion 枚举值驱动

        Args:
            action: 待执行的动作对象。
        """
        if action.type == ActionType.set_expression and action.expression:
            try:
                emotion = EmotionEnum(action.expression)
                await self._driver.drive(emotion=emotion, motion=None)
            except ValueError:
                pass  # 无法识别的表情名称，静默忽略
        elif action.type == ActionType.set_motion and action.motion:
            await self._driver.drive(emotion=None, motion=action.motion, duration=action.motion_duration)

    @property
    def last_emotion(self) -> EmotionEnum | None:
        """最近一次设置的情绪（代理到驱动器）。"""
        return self._driver.last_emotion

    @property
    def last_motion(self) -> MotionEnum | None:
        """最近一次设置的动作（代理到驱动器）。"""
        return self._driver.last_motion
