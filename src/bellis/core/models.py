"""数据模型模块 — 定义 Agent 运行所需的核心业务数据结构。

包含场景上下文、情感状态、动作记录、人格配置和 TTS 任务等模型，
为 Agent 的决策与执行提供结构化的数据支撑。
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from bellis.core.enums import EmotionEnum, MotionEnum


class SceneContext(BaseModel):
    """直播场景上下文，描述当前直播间的环境信息。

    Attributes:
        stream_title: 直播间标题。
        streamer_name: 主播名称。
        viewer_count: 当前观众人数。
        topic: 当前讨论话题。
        products: 当前推介的商品列表。
        phase: 当前直播阶段（如 idle、selling、chatting）。
    """

    stream_title: str = ""
    streamer_name: str = ""
    viewer_count: int = 0
    topic: str = ""
    products: list[str] = Field(default_factory=list)
    phase: str = "idle"


class EmotionState(BaseModel):
    """情感状态，追踪 Agent 当前的情感及其强度。

    Attributes:
        current: 当前情感类型。
        intensity: 情感强度，范围 [0.0, 1.0]。
        since: 当前情感开始的时间戳。
    """

    current: EmotionEnum = EmotionEnum.neutral
    intensity: float = Field(default=0.5, ge=0.0, le=1.0)
    since: datetime = Field(default_factory=datetime.now)


class ActionRecord(BaseModel):
    """动作历史记录，用于记录 Agent 已执行的动作。

    Attributes:
        action_type: 动作类型标识。
        description: 动作的文本描述。
        timestamp: 动作执行时间戳。
        emotion: 执行时的情感状态。
        motion: 执行时的肢体动作。
    """

    action_type: str
    description: str
    timestamp: datetime = Field(default_factory=datetime.now)
    emotion: EmotionEnum = EmotionEnum.neutral
    motion: MotionEnum = MotionEnum.idle


class PersonaConfig(BaseModel):
    """人格配置，定义 Agent 的性格、行为模式和 TTS 参数。

    Attributes:
        name: 人格标识名称。
        system_prompt: 注入到 LLM 的系统提示词。
        emotion_map: 关键词到情感的映射，用于情感推断。
        motion_map: 关键词到动作的映射，用于动作推断。
        tts_voice: TTS 语音音色标识。
        tts_speed_range: TTS 语速范围 (下限, 上限)。
    """

    name: str = "default"
    system_prompt: str = ""
    emotion_map: dict[str, EmotionEnum] = Field(default_factory=dict)
    motion_map: dict[str, MotionEnum] = Field(default_factory=dict)
    tts_voice: str = "default"
    tts_speed_range: tuple[float, float] = (0.8, 1.5)


class TTSTask(BaseModel):
    """TTS 任务，表示一次待执行的语音合成请求。

    Attributes:
        text: 待合成的文本内容。
        speed: 语速倍率，1.0 为正常语速。
        emotion: 合成时的情感标签。
        target_user: 目标用户名，用于定向播报场景。
        priority: 任务优先级，数值越小优先级越高。
    """

    text: str
    speed: float = 1.0
    emotion: EmotionEnum = EmotionEnum.neutral
    target_user: str | None = None
    priority: int = 0
