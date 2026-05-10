from __future__ import annotations

import asyncio

from bellis import ActionRecord, AgentState, EmotionEnum, EmotionState, LiveResponse, SceneContext
from bellis_gui.adapters.base import BaseAdapter
from bellis_gui.adapters.models import (
    EMOTION_COLORS,
    EMOTION_ICONS,
    GUIActionRecord,
    GUIEmotionState,
    GUIResponse,
    GUISceneContext,
    GUIState,
)


class StateAdapter(BaseAdapter[GUIState]):
    def __init__(self, maxsize: int = 50) -> None:
        super().__init__(maxsize=maxsize)
        self._latest_state: GUIState = GUIState()
        self._poll_interval: float = 0.5
        self._source_state: AgentState | None = None

    @property
    def latest(self) -> GUIState:
        return self._latest_state

    def update_source(self, state: AgentState) -> None:
        self._source_state = state
        gui_state = self._convert(state)
        self._latest_state = gui_state
        self._push(gui_state)

    def _convert(self, state: AgentState) -> GUIState:
        emotion_state = state.get("emotion_state", EmotionState())
        emotion = emotion_state.current if isinstance(emotion_state, EmotionState) else EmotionEnum.neutral
        intensity = emotion_state.intensity if isinstance(emotion_state, EmotionState) else 0.5

        scene_data = state.get("scene_context", SceneContext())
        scene = GUISceneContext(
            stream_title=scene_data.stream_title if isinstance(scene_data, SceneContext) else "",
            streamer_name=scene_data.streamer_name if isinstance(scene_data, SceneContext) else "",
            viewer_count=scene_data.viewer_count if isinstance(scene_data, SceneContext) else 0,
            topic=scene_data.topic if isinstance(scene_data, SceneContext) else "",
            phase=scene_data.phase if isinstance(scene_data, SceneContext) else "idle",
        )

        actions = state.get("action_history", [])
        recent = []
        for a in actions[-5:]:
            if isinstance(a, ActionRecord):
                recent.append(
                    GUIActionRecord(
                        action_type=a.action_type,
                        description=a.description,
                        emotion=a.emotion,
                        motion=a.motion,
                    )
                )

        event_queue = state.get("event_queue", [])
        tts_queue = state.get("tts_queue", [])

        return GUIState(
            emotion=GUIEmotionState(
                current=emotion,
                intensity=intensity,
                icon=EMOTION_ICONS.get(emotion, "😐"),
                color=EMOTION_COLORS.get(emotion, "#a6adc8"),
            ),
            scene=scene,
            recent_actions=recent,
            state_version=state.get("state_version", 0),
            interrupt_flag=state.get("interrupt_flag", False),
            event_queue_size=len(event_queue) if isinstance(event_queue, list) else 0,
            tts_queue_size=len(tts_queue) if isinstance(tts_queue, list) else 0,
        )

    def get_response(self, state: AgentState) -> GUIResponse | None:
        response = state.get("live_response")
        if response is None or not isinstance(response, LiveResponse):
            return None
        return GUIResponse(
            text=response.text,
            emotion=response.emotion,
            motion=response.motion,
            tts_speed=response.tts_speed,
            target_user=response.target_user,
            motion_duration=response.motion_duration,
        )

    async def _run(self) -> None:
        while self._running:
            await asyncio.sleep(self._poll_interval)
