from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from bellis.core.enums import EmotionEnum, MotionEnum


class SceneContext(BaseModel):
    stream_title: str = ""
    streamer_name: str = ""
    viewer_count: int = 0
    topic: str = ""
    products: list[str] = []
    phase: str = "idle"


class EmotionState(BaseModel):
    current: EmotionEnum = EmotionEnum.neutral
    intensity: float = Field(default=0.5, ge=0.0, le=1.0)
    since: datetime = Field(default_factory=datetime.now)


class ActionRecord(BaseModel):
    action_type: str
    description: str
    timestamp: datetime = Field(default_factory=datetime.now)
    emotion: EmotionEnum = EmotionEnum.neutral
    motion: MotionEnum = MotionEnum.idle


class PersonaConfig(BaseModel):
    name: str = "default"
    system_prompt: str = ""
    emotion_map: dict[str, EmotionEnum] = {}
    motion_map: dict[str, MotionEnum] = {}
    tts_voice: str = "default"
    tts_speed_range: tuple[float, float] = (0.8, 1.5)


class TTSTask(BaseModel):
    text: str
    speed: float = 1.0
    emotion: EmotionEnum = EmotionEnum.neutral
    target_user: str | None = None
    priority: int = 0
