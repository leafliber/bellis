"""领域对象 → 协议消息的序列化器。

将 AgentState、LiveEvent、Action、LiveResponse 等内部领域对象
转换为 protocol.py 中定义的 GUI 协议消息，供 Gateway 推送到前端。
"""

from __future__ import annotations

from bellis.core.actions import Action
from bellis.core.events import LiveEvent
from bellis.core.models import EmotionState, SceneContext
from bellis.core.response import LiveResponse
from bellis.core.state import AgentState
from bellis.gateway.protocol import (
    GUIActionRecord,
    GUIEmotionState,
    GUIEvent,
    GUIResponse,
    GUISceneContext,
    GUIState,
    ServerMessage,
)

# 情绪名称 → 前端展示图标
EMOTION_ICONS: dict[str, str] = {
    "happy": "😊",
    "excited": "🤩",
    "calm": "😌",
    "shy": "😳",
    "angry": "😠",
    "sad": "😢",
    "surprised": "😲",
    "neutral": "😐",
}

# 情绪名称 → 前端展示颜色
EMOTION_COLORS: dict[str, str] = {
    "happy": "#FFD700",
    "excited": "#FF6B6B",
    "calm": "#87CEEB",
    "shy": "#FFB6C1",
    "angry": "#FF4444",
    "sad": "#6495ED",
    "surprised": "#FFA500",
    "neutral": "#A0A0A0",
}

# 事件来源 → 前端展示来源
_SOURCE_MAP: dict[str, str] = {
    "danmaku": "danmaku",
    "gift": "gift",
    "super_chat": "danmaku",
    "follow": "system",
    "enter": "system",
    "idle": "system",
    "command": "command",
    "rag": "system",
    "system": "system",
}


def serialize_event(event: LiveEvent) -> ServerMessage:
    """将 LiveEvent 序列化为前端可消费的 WebSocket 消息。"""
    source = _SOURCE_MAP.get(event.source.value, "system")
    user_name = getattr(event, "user_name", "")
    payload = GUIEvent(
        display_text=event.content,
        source=source,
        color_tag=source,
        user_name=user_name,
        timestamp=event.timestamp.isoformat(),
        priority_name=event.priority.name,
    )
    return ServerMessage(type="event", payload=payload.model_dump())


def serialize_action(action: Action) -> ServerMessage:
    """将 Action 序列化为前端可消费的 WebSocket 消息。"""
    payload = {
        "action_type": action.type.value,
        "text": action.text,
        "expression": action.expression,
        "motion": action.motion.value if action.motion else None,
        "target_user": action.target_user,
    }
    return ServerMessage(type="action", payload=payload)


def serialize_state(state: AgentState) -> ServerMessage:
    """将 AgentState 序列化为前端可消费的 WebSocket 消息。"""
    emotion_state: EmotionState = state.get("emotion_state", EmotionState())
    scene: SceneContext = state.get("scene_context", SceneContext())
    emotion_val = emotion_state.current.value

    payload = GUIState(
        emotion=GUIEmotionState(
            current=emotion_val,
            intensity=emotion_state.intensity,
            icon=EMOTION_ICONS.get(emotion_val, "😐"),
            color=EMOTION_COLORS.get(emotion_val, "#A0A0A0"),
        ),
        scene=GUISceneContext(
            stream_title=scene.stream_title or "直播间",
            streamer_name=scene.streamer_name or "Bellis",
            viewer_count=scene.viewer_count,
            topic=scene.topic or "日常闲聊",
            phase="streaming",
        ),
        recent_actions=[
            GUIActionRecord(
                action_type=a.action_type,
                description=a.description,
                emotion=a.emotion.value,
                motion=a.motion.value if a.motion else "idle",
            )
            for a in state.get("action_history", [])[-5:]
        ],
        state_version=state.get("state_version", 0),
        interrupt_flag=state.get("interrupt_flag", False),
        event_queue_size=len(state.get("event_queue", [])),
        tts_queue_size=len(state.get("tts_queue", [])),
    )
    return ServerMessage(type="state", payload=payload.model_dump())


def serialize_response(state: AgentState) -> ServerMessage | None:
    """将 LiveResponse 序列化为前端可消费的 WebSocket 消息，无回复时返回 None。"""
    response: LiveResponse | None = state.get("live_response")
    if response is None:
        return None
    payload = GUIResponse(
        text=response.text,
        emotion=response.emotion.value,
        motion=response.motion.value,
        tts_speed=response.tts_speed,
        target_user=response.target_user,
        motion_duration=response.motion_duration,
    )
    return ServerMessage(type="response", payload=payload.model_dump())
