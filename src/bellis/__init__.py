"""Bellis — Live Streaming AI Agent Framework。

本模块是 bellis 包的顶层入口，统一导出核心领域模型（枚举、事件、状态等），
并提供 ``main()`` 函数作为 CLI 启动入口。
"""

from bellis.core.actions import Action
from bellis.core.enums import ActionType, CommandType, EmotionEnum, EventPriority, EventSource, MotionEnum
from bellis.core.events import (
    CommandEvent,
    DanmakuEvent,
    EnterEvent,
    FollowEvent,
    GiftEvent,
    IdleEvent,
    LiveEvent,
    RAGEvent,
    SuperChatEvent,
    VoiceEvent,
)
from bellis.core.models import ActionRecord, EmotionState, PersonaConfig, SceneContext, TTSTask
from bellis.core.response import LiveResponse
from bellis.core.state import AgentState

__all__ = [
    "ActionType",
    "CommandType",
    "EmotionEnum",
    "EventPriority",
    "EventSource",
    "MotionEnum",
    "Action",
    "CommandEvent",
    "DanmakuEvent",
    "EnterEvent",
    "FollowEvent",
    "GiftEvent",
    "IdleEvent",
    "LiveEvent",
    "RAGEvent",
    "SuperChatEvent",
    "VoiceEvent",
    "ActionRecord",
    "EmotionState",
    "PersonaConfig",
    "SceneContext",
    "TTSTask",
    "LiveResponse",
    "AgentState",
]


def main() -> None:
    """Bellis CLI 启动入口，委托给 bellis.app.main 执行。"""
    from bellis.app import main as app_main

    app_main()
