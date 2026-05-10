from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from bellis.core.enums import EventPriority, EventSource


class LiveEvent(BaseModel):
    content: str
    priority: EventPriority = EventPriority.NORMAL
    source: EventSource = EventSource.SYSTEM
    timestamp: datetime = Field(default_factory=datetime.now)
    metadata: dict = {}

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


class CommandEvent(LiveEvent):
    source: EventSource = EventSource.COMMAND
    priority: EventPriority = EventPriority.CRITICAL
    command_type: str = ""
    payload: dict = {}


class RAGEvent(LiveEvent):
    source: EventSource = EventSource.RAG
    query: str = ""
    retrieved_docs: list[str] = []
