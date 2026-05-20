"""响应模块 — 定义 Agent 生成的直播响应数据结构。

LiveResponse 是 Agent 决策的最终输出，包含文本、情感、动作、TTS 参数等，
由执行节点读取并分发到各输出通道。
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from bellis.core.enums import EmotionEnum, EventPriority, MotionEnum


class LiveResponse(BaseModel):
    """直播响应，Agent 决策节点的输出结果。

    Attributes:
        text: 回复文本内容。
        emotion: 伴随回复的情感状态。
        motion: 伴随回复的肢体动作。
        tts_speed: TTS 语速倍率，范围 [0.8, 1.5]。
        priority: 响应优先级，数值越小优先级越高。
        target_user: 目标用户名，用于定向回复场景。
        motion_duration: 动作持续时间（秒），范围 [0.1, 10.0]。
        wait_for_next: 是否等待下一个响应再执行，用于合并连续动作。
        metadata: 附加元数据，供插件或中间件使用。
    """

    text: str
    emotion: EmotionEnum = EmotionEnum.neutral
    motion: MotionEnum = MotionEnum.idle
    tts_speed: float = Field(default=1.0, ge=0.8, le=1.5)
    priority: int = Field(default=EventPriority.NORMAL.value, ge=0)
    target_user: str | None = None
    motion_duration: float = Field(default=1.0, ge=0.1, le=10.0)
    wait_for_next: bool = False
    metadata: dict = Field(default_factory=dict)
