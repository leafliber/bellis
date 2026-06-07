"""动作模块 — 定义 Agent 可执行的各类动作。

Action 是 Agent 输出的最小执行单元，由决策节点生成后交由执行节点分发。
支持语音播报、表情切换、动作播放、弹幕回复等多种动作类型。
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from bellis.core.enums import ActionType, EmotionEnum, MotionEnum


class Action(BaseModel):
    """Agent 可执行的动作。

    Attributes:
        type: 动作类型，决定该动作的执行方式。
        text: 语音文本，仅在 speak / reply_danmaku 类型时使用。
        emotion: 伴随动作的情感状态。
        expression: Live2D 表情名称，用于 set_expression 类型。
        motion: Live2D 动作枚举，用于 set_motion 类型。
        motion_duration: 动作持续时间（秒）。
        reply_text: 弹幕回复文本，仅在 reply_danmaku 类型时使用。
        target_user: 目标用户名，用于定向回复场景。
        tts_speed: TTS 语速倍率，1.0 为正常语速。
        priority: 执行优先级，数值越小优先级越高。
        metadata: 附加元数据，供插件或中间件使用。
    """

    type: ActionType
    # speak / reply_danmaku
    text: str | None = None
    emotion: EmotionEnum | None = None
    # Live2D
    expression: str | None = None
    motion: MotionEnum | None = None
    motion_duration: float = 1.0
    parameters: dict[str, float] | None = None  # 细粒度参数控制（如 Cubism 参数）
    intensity: float = 1.0  # 情绪/表情强度
    # danmaku reply
    reply_text: str | None = None
    # common
    target_user: str | None = None
    tts_speed: float = 1.0
    priority: int = 0
    metadata: dict = Field(default_factory=dict)
