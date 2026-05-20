from __future__ import annotations

from bellis.core.context import AgentContext
from bellis.core.enums import EventPriority, EventSource
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
)
from bellis.core.state import AgentState

_GREETING_KEYWORDS = (
    "你好", "嗨", "哈喽", "hello", "hi",
    "早上好", "晚上好", "下午好", "早安", "晚安",
    "大家好", "你们好",
)
_QUESTION_KEYWORDS = (
    "吗", "？", "?", "怎么", "什么", "为什么",
    "如何", "哪", "几", "多少", "是不是", "能不能", "可以", "吗？",
)
_POSITIVE_KEYWORDS = (
    "开心", "高兴", "喜欢", "爱", "棒", "厉害", "牛", "赞",
    "哈哈", "嘻嘻", "感谢", "谢谢", "加油", "支持", "好耶",
    "太好了", "可爱", "漂亮", "帅",
)
_NEGATIVE_KEYWORDS = (
    "讨厌", "烦", "生气", "难过", "伤心", "差", "烂", "垃圾",
    "无聊", "滚", "恶心", "退钱", "好丑",
)


def _classify_intent(event: LiveEvent) -> str:
    if isinstance(event, (GiftEvent, SuperChatEvent)):
        return "gift"
    if isinstance(event, CommandEvent):
        return "command"
    if isinstance(event, RAGEvent):
        return "question"
    if isinstance(event, (EnterEvent, FollowEvent)):
        return "greeting"
    if isinstance(event, IdleEvent):
        return "idle"
    content = event.content.lower().strip()
    if any(kw in content for kw in _GREETING_KEYWORDS):
        return "greeting"
    if any(kw in content for kw in _QUESTION_KEYWORDS):
        return "question"
    if len(content) < 2 or content.isdigit():
        return "spam"
    return "chat"


def _analyze_emotion(event: LiveEvent) -> str:
    if isinstance(event, (GiftEvent, SuperChatEvent)):
        return "excited"
    if isinstance(event, FollowEvent):
        return "happy"
    if isinstance(event, (CommandEvent, IdleEvent)):
        return "neutral"
    content = event.content.lower()
    positive = sum(1 for kw in _POSITIVE_KEYWORDS if kw in content)
    negative = sum(1 for kw in _NEGATIVE_KEYWORDS if kw in content)
    if positive > negative:
        return "happy"
    if negative > positive:
        return "angry"
    return "neutral"


def _reassess_priority(event: LiveEvent) -> EventPriority:
    if isinstance(event, SuperChatEvent):
        return EventPriority.CRITICAL
    if isinstance(event, GiftEvent):
        if event.coin_value >= 1000:
            return EventPriority.CRITICAL
        return EventPriority.HIGH
    if isinstance(event, FollowEvent):
        return EventPriority.HIGH
    if isinstance(event, CommandEvent):
        return EventPriority.CRITICAL
    if isinstance(event, DanmakuEvent):
        if event.user_level < 5 and event.fan_badge is None:
            return EventPriority.LOW
        if event.fan_badge is not None:
            return EventPriority.NORMAL
    if isinstance(event, EnterEvent):
        return EventPriority.LOW
    return event.priority


def _get_context(state: AgentState) -> AgentContext:
    ctx = state.get("_context")
    if ctx is None:
        raise RuntimeError("AgentState 中缺少 _context，请确保 BellisApp 已正确初始化")
    return ctx


def dequeue_event(state: AgentState) -> dict:
    queue = state.get("event_queue", [])
    if not queue:
        return {"current_event": None}
    return {"current_event": queue[0], "event_queue": queue[1:]}


async def perceive(state: AgentState) -> dict:
    ctx = _get_context(state)
    if ctx.hook_manager:
        state = await ctx.hook_manager.fire("pre_perceive", state)

    event = state.get("current_event")
    if event is None:
        result = {"idle_ticks": state.get("idle_ticks", 0) + 1}
    elif isinstance(event, IdleEvent):
        result = {"idle_ticks": state.get("idle_ticks", 0) + 1, "current_event": None}
    else:
        metrics = dict(state.get("metrics") or {})
        reassessed = _reassess_priority(event)
        metrics["perception"] = {
            "intent": _classify_intent(event),
            "emotion": _analyze_emotion(event),
            "original_priority": event.priority.name,
            "reassessed_priority": reassessed.name,
        }
        result = {"metrics": metrics, "idle_ticks": 0}

    if ctx.hook_manager:
        state = await ctx.hook_manager.fire("post_perceive", {**state, **result})
        result = {k: state[k] for k in result if k in state}

    return result


def route_after_perception(state: AgentState) -> str:
    ctx: AgentContext | None = state.get("_context")
    idle_threshold = ctx.idle_threshold if ctx else 5

    event = state.get("current_event")
    idle_ticks = state.get("idle_ticks", 0)

    if event is None:
        if idle_ticks >= idle_threshold:
            return "think"
        return "end"

    if state.get("interrupt_flag") and event.source == EventSource.COMMAND:
        return "interrupt"

    metrics = state.get("metrics") or {}
    perception = metrics.get("perception") or {}
    priority_name = perception.get("reassessed_priority", event.priority.name)
    intent = perception.get("intent", "")

    try:
        priority = EventPriority[priority_name]
    except KeyError:
        priority = event.priority

    if priority in (EventPriority.CRITICAL, EventPriority.HIGH, EventPriority.NORMAL):
        return "think"
    if priority == EventPriority.LOW or intent == "spam":
        return "end"

    return "think"
