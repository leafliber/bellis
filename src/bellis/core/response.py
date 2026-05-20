from __future__ import annotations

from pydantic import BaseModel, Field

from bellis.core.enums import EmotionEnum, EventPriority, MotionEnum


class LiveResponse(BaseModel):
    text: str
    emotion: EmotionEnum = EmotionEnum.neutral
    motion: MotionEnum = MotionEnum.idle
    tts_speed: float = Field(default=1.0, ge=0.8, le=1.5)
    priority: int = Field(default=EventPriority.NORMAL.value, ge=0)
    target_user: str | None = None
    motion_duration: float = Field(default=1.0, ge=0.1, le=10.0)
    wait_for_next: bool = False
    metadata: dict = Field(default_factory=dict)
