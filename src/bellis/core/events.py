from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from bellis.core.enums import CommandType, EventPriority, EventSource


class LiveEvent(BaseModel):
    content: str
    priority: EventPriority = EventPriority.NORMAL
    source: EventSource = EventSource.SYSTEM
    timestamp: datetime = Field(default_factory=datetime.now)
    metadata: dict = Field(default_factory=dict)

    model_config = {"frozen": True}


class DanmakuEvent(LiveEvent):
    source: EventSource = EventSource.DANMAKU
    user_id: str = ""
    user_name: str = ""
    user_level: int = 0
    fan_badge: str | None = None


class GiftEvent(LiveEvent):
    source: EventSource = EventSource.GIFT
    priority: EventPriority = EventPriority.HIGH
    user_id: str = ""
    user_name: str = ""
    gift_name: str = ""
    gift_count: int = 1
    coin_value: int = 0


class SuperChatEvent(LiveEvent):
    source: EventSource = EventSource.SUPER_CHAT
    priority: EventPriority = EventPriority.CRITICAL
    user_id: str = ""
    user_name: str = ""
    price: int = 0
    duration: int = 0


class VoiceEvent(LiveEvent):
    source: EventSource = EventSource.VOICE
    audio_data: bytes = b""
    language: str = "zh"


class EnterEvent(LiveEvent):
    source: EventSource = EventSource.ENTER
    priority: EventPriority = EventPriority.LOW
    user_id: str = ""
    user_name: str = ""


class FollowEvent(LiveEvent):
    source: EventSource = EventSource.FOLLOW
    priority: EventPriority = EventPriority.HIGH
    user_id: str = ""
    user_name: str = ""


class CommandEvent(LiveEvent):
    source: EventSource = EventSource.COMMAND
    priority: EventPriority = EventPriority.CRITICAL
    command_type: CommandType = CommandType.SWITCH_TOPIC
    payload: dict = Field(default_factory=dict)


class RAGEvent(LiveEvent):
    source: EventSource = EventSource.RAG
    query: str = ""
    retrieved_docs: list[str] = Field(default_factory=list)


class IdleEvent(LiveEvent):
    source: EventSource = EventSource.IDLE
    priority: EventPriority = EventPriority.LOW
