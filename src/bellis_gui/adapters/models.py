from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from bellis import EmotionEnum, EventSource, MotionEnum


class GUIEvent(BaseModel):
    display_text: str
    source: EventSource
    color_tag: str
    user_name: str = ""
    timestamp: datetime = Field(default_factory=datetime.now)
    priority_name: str = "NORMAL"
    metadata: dict = {}


class GUIEmotionState(BaseModel):
    current: EmotionEnum = EmotionEnum.neutral
    intensity: float = 0.5
    icon: str = "😐"
    color: str = "#a6adc8"


class GUISceneContext(BaseModel):
    stream_title: str = ""
    streamer_name: str = ""
    viewer_count: int = 0
    topic: str = ""
    phase: str = "idle"


class GUIActionRecord(BaseModel):
    action_type: str = ""
    description: str = ""
    emotion: EmotionEnum = EmotionEnum.neutral
    motion: MotionEnum = MotionEnum.idle


class GUIState(BaseModel):
    emotion: GUIEmotionState = Field(default_factory=GUIEmotionState)
    scene: GUISceneContext = Field(default_factory=GUISceneContext)
    recent_actions: list[GUIActionRecord] = []
    state_version: int = 0
    interrupt_flag: bool = False
    event_queue_size: int = 0
    tts_queue_size: int = 0


class GUIResponse(BaseModel):
    text: str = ""
    emotion: EmotionEnum = EmotionEnum.neutral
    motion: MotionEnum = MotionEnum.idle
    tts_speed: float = 1.0
    target_user: str | None = None
    motion_duration: float = 1.0


class GUIPersonaConfig(BaseModel):
    name: str = "default"
    system_prompt: str = ""
    tts_voice: str = "default"


class GUIModelConfig(BaseModel):
    primary_model: str = "openai:gpt-4o"
    fallback_model: str = "openai:gpt-4o-mini"
    max_retries: int = 3
    temperature: float = 0.7


class GUIPlatformConfig(BaseModel):
    danmaku_ws_uri: str = ""
    command_ws_uri: str = ""
    max_queue_size: int = 1000
    danmaku_qps_limit: int = 50
    tts_queue_limit: int = 20


class GUIConfig(BaseModel):
    personas: dict[str, GUIPersonaConfig] = {}
    active_persona: str = "default"
    model: GUIModelConfig = Field(default_factory=GUIModelConfig)
    platform: GUIPlatformConfig = Field(default_factory=GUIPlatformConfig)


class GUITraceSpan(BaseModel):
    name: str = ""
    duration_ms: float = 0.0
    input_summary: str = ""
    output_summary: str = ""
    children: list[GUITraceSpan] = []


class GUIMetrics(BaseModel):
    event_queue_size: int = 0
    tts_queue_size: int = 0
    circuit_breaker_state: str = "closed"
    state_version: int = 0
    events_per_minute: float = 0.0


EMOTION_ICONS: dict[EmotionEnum, str] = {
    EmotionEnum.happy: "😊",
    EmotionEnum.excited: "🤩",
    EmotionEnum.calm: "😌",
    EmotionEnum.shy: "😳",
    EmotionEnum.angry: "😠",
    EmotionEnum.sad: "😢",
    EmotionEnum.surprised: "😲",
    EmotionEnum.neutral: "😐",
}

EMOTION_COLORS: dict[EmotionEnum, str] = {
    EmotionEnum.happy: "#a6e3a1",
    EmotionEnum.excited: "#f9e2af",
    EmotionEnum.calm: "#89b4fa",
    EmotionEnum.shy: "#f5c2e7",
    EmotionEnum.angry: "#f38ba8",
    EmotionEnum.sad: "#89dceb",
    EmotionEnum.surprised: "#fab387",
    EmotionEnum.neutral: "#a6adc8",
}

SOURCE_COLORS: dict[EventSource, str] = {
    EventSource.DANMAKU: "danmaku-color",
    EventSource.GIFT: "gift-color",
    EventSource.COMMAND: "command-color",
    EventSource.RAG: "primary",
    EventSource.SYSTEM: "system-color",
}
