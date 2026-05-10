from __future__ import annotations

from typing import TypedDict

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
    persona: PersonaConfig
    state_version: int
    interrupt_flag: bool
    tts_queue: list[TTSTask]
    metrics: dict
