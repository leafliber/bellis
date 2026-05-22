"""前后端 WebSocket 通信协议定义。

所有消息模型均为不可变（frozen），与前端 types/index.ts 保持一一对应。
Gateway 内部只操作这些协议模型，不直接序列化领域对象。
"""

from __future__ import annotations

from pydantic import BaseModel, Field  # noqa: F401

# ─── 服务端 → 客户端 消息载荷 ──────────────────────────────────────


class GUIEvent(BaseModel):
    """前端展示的事件载荷。"""

    model_config = {"frozen": True}

    display_text: str
    source: str
    color_tag: str
    user_name: str
    timestamp: str
    priority_name: str
    metadata: dict = Field(default_factory=dict)


class GUIEmotionState(BaseModel):
    """前端展示的情感状态载荷。"""

    model_config = {"frozen": True}

    current: str
    intensity: float
    icon: str
    color: str


class GUISceneContext(BaseModel):
    """前端展示的场景上下文载荷。"""

    model_config = {"frozen": True}

    stream_title: str
    streamer_name: str
    viewer_count: int
    topic: str
    phase: str


class GUIActionRecord(BaseModel):
    """前端展示的动作历史记录载荷。"""

    model_config = {"frozen": True}

    action_type: str
    description: str
    emotion: str
    motion: str


class GUIState(BaseModel):
    """前端展示的 Agent 状态载荷。"""

    model_config = {"frozen": True}

    emotion: GUIEmotionState
    scene: GUISceneContext
    recent_actions: list[GUIActionRecord]
    state_version: int
    interrupt_flag: bool
    event_queue_size: int
    tts_queue_size: int


class GUIResponse(BaseModel):
    """前端展示的 Agent 响应载荷。"""

    model_config = {"frozen": True}

    text: str
    emotion: str
    motion: str
    tts_speed: float
    target_user: str | None
    motion_duration: float


class GUIMetrics(BaseModel):
    """前端展示的运行指标载荷。"""

    model_config = {"frozen": True}

    event_queue_size: int
    tts_queue_size: int
    circuit_breaker_state: str
    state_version: int
    events_per_minute: float


class GUITraceSpan(BaseModel):
    """前端展示的追踪跨度载荷，支持树形嵌套。"""

    model_config = {"frozen": True}

    name: str
    duration_ms: float
    input_summary: str = ""
    output_summary: str = ""
    children: list[GUITraceSpan] = Field(default_factory=list)


class GUIConfig(BaseModel):
    """前端展示的配置载荷。"""

    model_config = {"frozen": True}

    personas: dict[str, dict]
    active_persona: str
    model: dict
    platform: dict
    plugins: dict[str, dict] = Field(default_factory=dict)
    plugin_schemas: dict[str, dict] = Field(default_factory=dict)


# ─── 服务端消息 ──────────────────────────────────────────────────────


class ServerMessage(BaseModel):
    """服务端 → 客户端的统一消息信封。"""

    model_config = {"frozen": True}

    type: str  # "event" | "state" | "response" | "action" | "metrics" | "trace" | "config"
    payload: dict


# ─── 客户端 → 服务端 消息载荷 ──────────────────────────────────────


class CommandPayload(BaseModel):
    """客户端发送弹幕的载荷。"""

    command: str


class SwitchPersonaPayload(BaseModel):
    """客户端切换人设的载荷。"""

    name: str


class UpdateConfigPayload(BaseModel):
    """客户端更新配置的载荷。

    支持局部更新：只传需要修改的字段，未传的字段保持不变。
    """

    personas: dict[str, dict] | None = None
    active_persona: str | None = None
    model: dict | None = None
    platform: dict | None = None
    plugins: dict[str, dict] | None = None


# ─── 客户端消息 ──────────────────────────────────────────────────────


class ClientMessage(BaseModel):
    """客户端 → 服务端的统一消息信封。"""

    type: str  # "command" | "start_agent" | "stop_agent" | "switch_persona" | "update_config" | "reload_config"
    payload: dict = Field(default_factory=dict)
