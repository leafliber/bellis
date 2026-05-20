"""状态模块 — 定义 LangGraph 图的状态字典结构。

AgentState 是 LangGraph 各节点间传递的核心状态，包含事件队列、
场景上下文、情感状态、动作历史、响应结果等业务数据。
框架运行时引用（AgentContext）通过 _context 私有字段传递，
不应在业务逻辑中直接使用。
"""

from __future__ import annotations

from typing import Any, TypedDict

from bellis.core.actions import Action
from bellis.core.events import LiveEvent
from bellis.core.models import ActionRecord, EmotionState, PersonaConfig, SceneContext, TTSTask
from bellis.core.response import LiveResponse


class AgentState(TypedDict, total=False):
    """Agent 状态字典，LangGraph 各节点间传递的核心数据结构。

    使用 TypedDict 定义以提供类型提示，total=False 表示所有字段均为可选。
    框架运行时上下文通过 _context 字段传递，不应在业务逻辑中直接访问。

    Attributes:
        event_queue: 待处理的事件队列。
        current_event: 当前正在处理的事件。
        scene_context: 直播场景上下文信息。
        emotion_state: Agent 当前情感状态。
        action_history: 已执行动作的历史记录。
        live_response: Agent 决策生成的直播响应。
        actions: 待执行的动作列表。
        persona: 当前生效的人格配置。
        state_version: 状态版本号，用于乐观锁。
        interrupt_flag: 中断标记，为 True 时暂停当前流程。
        tts_queue: 待执行的 TTS 任务队列。
        idle_ticks: 连续空闲 tick 计数，用于空闲判定。
        metrics: 运行指标字典，存储自定义业务指标。
        _context: 框架运行时上下文（AgentContext），由 BellisApp 注入。
        _streaming_tts_pushed: 流式模式标记，stream_think 已推送 TTS 时为 True，act 不再重复推送。
    """

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
    """从 AgentState 中提取 AgentContext。

    Args:
        state: Agent 状态字典。

    Returns:
        AgentContext 实例。

    Raises:
        RuntimeError: 当 _context 字段缺失时抛出，通常表示 BellisApp 未正确初始化。
    """
    ctx = state.get("_context")
    if ctx is None:
        raise RuntimeError("AgentState 中缺少 _context，请确保 BellisApp 已正确初始化")
    return ctx
