from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from bellis.core.enums import EventPriority, EventSource
from bellis.core.events import CommandEvent, DanmakuEvent, GiftEvent, LiveEvent, RAGEvent
from bellis.core.state import AgentState

_GREETING_KEYWORDS = (
    "你好", "嗨", "哈喽", "hello", "hi", "早上好", "晚上好",
    "下午好", "早安", "晚安", "大家好", "你们好",
)
_QUESTION_KEYWORDS = (
    "吗", "？", "?", "怎么", "什么", "为什么", "如何", "哪",
    "几", "多少", "是不是", "能不能", "可以", "吗？",
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
    if isinstance(event, GiftEvent):
        return "gift"
    if isinstance(event, CommandEvent):
        return "command"
    if isinstance(event, RAGEvent):
        return "question"
    content = event.content.lower().strip()
    if any(kw in content for kw in _GREETING_KEYWORDS):
        return "greeting"
    if any(kw in content for kw in _QUESTION_KEYWORDS):
        return "question"
    if len(content) < 2 or content.isdigit():
        return "spam"
    return "chat"


def _analyze_emotion(event: LiveEvent) -> str:
    if isinstance(event, GiftEvent):
        return "happy"
    if isinstance(event, CommandEvent):
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
    if isinstance(event, GiftEvent):
        if event.coin_value >= 1000:
            return EventPriority.CRITICAL
        return EventPriority.HIGH
    if isinstance(event, CommandEvent):
        return EventPriority.CRITICAL
    if isinstance(event, DanmakuEvent):
        if event.user_level < 5 and event.fan_badge is None:
            return EventPriority.LOW
        if event.fan_badge is not None:
            return EventPriority.NORMAL
    return event.priority


def dequeue_event(state: AgentState) -> dict:
    queue = state.get("event_queue", [])
    if not queue:
        return {"current_event": None}
    return {"current_event": queue[0], "event_queue": queue[1:]}


def perceive(state: AgentState) -> dict:
    event = state.get("current_event")
    if event is None:
        return {}
    metrics = dict(state.get("metrics") or {})
    reassessed = _reassess_priority(event)
    metrics["perception"] = {
        "intent": _classify_intent(event),
        "emotion": _analyze_emotion(event),
        "original_priority": event.priority.name,
        "reassessed_priority": reassessed.name,
    }
    return {"metrics": metrics}


def throttle(state: AgentState) -> dict:
    event = state.get("current_event")
    metrics = dict(state.get("metrics") or {})
    throttled = list(metrics.get("throttled") or [])
    if event is not None:
        throttled.append({
            "content": event.content,
            "source": event.source.value,
        })
    metrics["throttled"] = throttled
    return {"metrics": metrics}


def route_after_perception(state: AgentState) -> str:
    event = state.get("current_event")
    if event is None:
        return "idle"
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
    if priority in (EventPriority.CRITICAL, EventPriority.HIGH):
        return "decision"
    if priority == EventPriority.NORMAL:
        return "decision"
    if priority == EventPriority.LOW or intent == "spam":
        return "throttle"
    return "decision"


def build_perception_graph():
    graph = StateGraph(AgentState)
    graph.add_node("dequeue_event", dequeue_event)
    graph.add_node("perceive", perceive)
    graph.add_node("throttle", throttle)
    graph.add_edge(START, "dequeue_event")
    graph.add_edge("dequeue_event", "perceive")
    graph.add_conditional_edges(
        "perceive",
        route_after_perception,
        {
            "idle": END,
            "interrupt": END,
            "decision": END,
            "throttle": "throttle",
        },
    )
    graph.add_edge("throttle", END)
    return graph.compile()
