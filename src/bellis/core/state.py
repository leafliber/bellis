from __future__ import annotations

from typing import Any, TypedDict

from bellis.core.actions import Action
from bellis.core.events import LiveEvent
from bellis.core.models import ActionRecord, EmotionState, PersonaConfig, SceneContext, TTSTask
from bellis.core.response import LiveResponse


class AgentState(TypedDict, total=False):
    event_queue: list[LiveEvent]
    current_event: LiveEvent | None
    scene_context: SceneContext
    emotion_state: EmotionState
    action_history: list[ActionRecord]
    live_response: LiveResponse | None
    actions: list[Action]
    persona: PersonaConfig
    state_version: int
    interrupt_flag: bool
    tts_queue: list[TTSTask]
    idle_ticks: int
    metrics: dict[str, Any]
    # 框架运行时上下文，由 BellisApp 注入
    _context: Any
    # 流式模式标记：stream_think 已推送 TTS，act 不再重复
    _streaming_tts_pushed: bool


def get_context(state: AgentState) -> Any:
    """从 AgentState 中提取 AgentContext。"""
    ctx = state.get("_context")
    if ctx is None:
        raise RuntimeError("AgentState 中缺少 _context，请确保 BellisApp 已正确初始化")
    return ctx
