from __future__ import annotations

from pydantic import BaseModel

from bellis.core.enums import ActionType, EmotionEnum, MotionEnum


class Action(BaseModel):
    type: ActionType
    # speak / reply_danmaku
    text: str | None = None
    emotion: EmotionEnum | None = None
    # Live2D
    expression: str | None = None
    motion: MotionEnum | None = None
    motion_duration: float = 1.0
    # danmaku reply
    reply_text: str | None = None
    # common
    target_user: str | None = None
    tts_speed: float = 1.0
    priority: int = 0
    metadata: dict = {}
