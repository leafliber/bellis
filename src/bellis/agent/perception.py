"""感知模块：负责事件出队、意图分类、情绪分析和优先级重评估。

本模块实现了 Agent 状态图中的 PERCEIVE 阶段，包括：
- 从事件队列中出队当前事件
- 基于关键词的事件意图分类（问候、提问、礼物、命令等）
- 基于关键词的情绪分析（正面/负面/中性）
- 事件优先级重评估（根据事件类型和属性调整优先级）
- 感知后的路由决策（是否需要响应、是否中断等）
"""

from __future__ import annotations

import logging

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
from bellis.core.state import AgentState, get_context
from bellis.observability.otel import traced

logger = logging.getLogger(__name__)

# 问候类关键词，用于识别问候意图
_GREETING_KEYWORDS = (
    "你好", "嗨", "哈喽", "hello", "hi",
    "早上好", "晚上好", "下午好", "早安", "晚安",
    "大家好", "你们好",
)
# 提问类关键词，用于识别提问意图
_QUESTION_KEYWORDS = (
    "吗", "？", "?", "怎么", "什么", "为什么",
    "如何", "哪", "几", "多少", "是不是", "能不能", "可以", "吗？",
)
# 正面情绪关键词，用于情绪分析
_POSITIVE_KEYWORDS = (
    "开心", "高兴", "喜欢", "爱", "棒", "厉害", "牛", "赞",
    "哈哈", "嘻嘻", "感谢", "谢谢", "加油", "支持", "好耶",
    "太好了", "可爱", "漂亮", "帅",
)
# 负面情绪关键词，用于情绪分析
_NEGATIVE_KEYWORDS = (
    "讨厌", "烦", "生气", "难过", "伤心", "差", "烂", "垃圾",
    "无聊", "滚", "恶心", "退钱", "好丑",
)


def _classify_intent(event: LiveEvent) -> str:
    """对事件进行意图分类。

    分类策略：
    1. 特定事件类型直接映射意图（礼物→gift、命令→command、RAG→question、
       进入/关注→greeting、空闲→idle）。
    2. 弹幕类事件基于关键词匹配（问候、提问）。
    3. 过短或纯数字内容识别为 spam。
    4. 其余归类为 chat。

    Args:
        event: 待分类的直播事件。

    Returns:
        意图标签字符串，取值为 "gift"/"command"/"question"/"greeting"/"idle"/"spam"/"chat"。
    """
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
        return "spam"  # 过短或纯数字内容视为垃圾信息
    return "chat"


def _analyze_emotion(event: LiveEvent) -> str:
    """分析事件的情绪倾向。

    分析策略：
    1. 特定事件类型直接映射情绪（礼物/醒目留言→excited、关注→happy、
       命令/空闲→neutral）。
    2. 弹幕类事件通过正负面关键词计数比较判断情绪倾向。

    Args:
        event: 待分析情绪的直播事件。

    Returns:
        情绪标签字符串，取值为 "excited"/"happy"/"angry"/"neutral"。
    """
    if isinstance(event, (GiftEvent, SuperChatEvent)):
        return "excited"
    if isinstance(event, FollowEvent):
        return "happy"
    if isinstance(event, (CommandEvent, IdleEvent)):
        return "neutral"
    content = event.content.lower()
    positive = sum(1 for kw in _POSITIVE_KEYWORDS if kw in content)
    negative = sum(1 for kw in _NEGATIVE_KEYWORDS if kw in content)
    # 通过正负面关键词命中数比较判断情绪倾向
    if positive > negative:
        return "happy"
    if negative > positive:
        return "angry"
    return "neutral"


def _reassess_priority(event: LiveEvent) -> EventPriority:
    """根据事件类型和属性重评估事件优先级。

    重评估规则：
    - 醒目留言：CRITICAL（付费内容优先处理）。
    - 礼物：coin_value ≥ 1000 为 CRITICAL，否则为 HIGH。
    - 关注：HIGH。
    - 命令：CRITICAL（运营指令优先处理）。
    - 弹幕：低等级且无粉丝牌为 LOW，有粉丝牌为 NORMAL。
    - 进入：LOW。
    - 其他：保留原始优先级。

    Args:
        event: 待重评估优先级的直播事件。

    Returns:
        重评估后的 EventPriority 枚举值。
    """
    if isinstance(event, SuperChatEvent):
        return EventPriority.CRITICAL
    if isinstance(event, GiftEvent):
        if event.coin_value >= 1000:
            return EventPriority.CRITICAL  # 高价值礼物提升为最高优先级
        return EventPriority.HIGH
    if isinstance(event, FollowEvent):
        return EventPriority.HIGH
    if isinstance(event, CommandEvent):
        return EventPriority.CRITICAL
    if isinstance(event, DanmakuEvent):
        if event.user_level < 5 and event.fan_badge is None:
            return EventPriority.LOW  # 低等级且无粉丝牌的用户弹幕降为低优先级
        if event.fan_badge is not None:
            return EventPriority.NORMAL
    if isinstance(event, EnterEvent):
        return EventPriority.LOW
    return event.priority


@traced("bellis.node.dequeue_event")
def dequeue_event(state: AgentState) -> dict:
    """从事件队列中出队第一个事件。

    将队列头部事件设为 current_event，并从队列中移除。
    队列为空时将 current_event 设为 None。

    Args:
        state: 当前 Agent 状态字典，需包含 "event_queue" 键。

    Returns:
        包含 "current_event" 和 "event_queue" 的状态更新字典。
    """
    queue = state.get("event_queue", [])
    if not queue:
        return {"current_event": None}
    return {"current_event": queue[0], "event_queue": queue[1:]}


@traced("bellis.node.perceive")
async def perceive(state: AgentState) -> dict:
    """执行感知：对当前事件进行意图分类、情绪分析和优先级重评估。

    流程：
    1. 触发 pre_perceive 钩子。
    2. 若无当前事件则增加 idle_ticks 计数。
    3. 若有事件则执行意图分类、情绪分析和优先级重评估，将结果写入 metrics。
    4. 触发 post_perceive 钩子。

    Args:
        state: 当前 Agent 状态字典。

    Returns:
        包含 metrics 和 idle_ticks 的状态更新字典。
    """
    ctx = get_context(state)
    if ctx.hook_manager:
        state = await ctx.hook_manager.fire("pre_perceive", state)

    event = state.get("current_event")
    if event is None:
        result = {"idle_ticks": state.get("idle_ticks", 0) + 1}
    else:
        metrics = dict(state.get("metrics") or {})
        reassessed = _reassess_priority(event)
        intent = _classify_intent(event)
        emotion = _analyze_emotion(event)
        metrics["perception"] = {
            "intent": intent,
            "emotion": emotion,
            "original_priority": event.priority.name,
            "reassessed_priority": reassessed.name,
        }
        logger.debug(
            "感知事件: source=%s intent=%s emotion=%s priority=%s→%s",
            event.source.value, intent, emotion, event.priority.name, reassessed.name,
        )
        result = {"metrics": metrics, "idle_ticks": 0}

    if ctx.hook_manager:
        state = await ctx.hook_manager.fire("post_perceive", {**state, **result})
        result = {k: state[k] for k in result if k in state}

    return result


def route_after_perception(state: AgentState) -> str:
    """感知后的路由决策：决定下一步进入哪个节点。

    路由规则（按优先级）：
    1. 无事件 + idle_ticks 达到阈值 → "think"（主动活跃气氛）。
    2. 无事件 + idle_ticks 未达阈值 → "end"（本轮结束）。
    3. 中断标志 + 命令事件 → "interrupt"。
    4. 优先级为 CRITICAL/HIGH/NORMAL → "think"。
    5. idle 意图 + idle_ticks 达到阈值 → "think"。
    6. LOW 优先级或 spam 意图 → "end"（跳过不响应）。
    7. 其他情况 → "end"。

    Args:
        state: 当前 Agent 状态字典。

    Returns:
        路由目标节点名称："think"/"interrupt"/"end"。
    """
    ctx: AgentContext | None = state.get("_context")
    idle_threshold = ctx.idle_threshold if ctx else 5  # 默认空闲阈值为 5 轮

    event = state.get("current_event")
    idle_ticks = state.get("idle_ticks", 0)

    if event is None:
        if idle_ticks >= idle_threshold:
            return "think"
        return "end"

    if state.get("interrupt_flag") and event.source == EventSource.COMMAND:
        return "interrupt"  # 中断标志且为命令事件，进入中断处理

    metrics = state.get("metrics") or {}
    perception = metrics.get("perception") or {}
    priority_name = perception.get("reassessed_priority", event.priority.name)
    intent = perception.get("intent", "")

    try:
        priority = EventPriority[priority_name]
    except KeyError:
        # 优先级名称无法识别时回退到事件原始优先级
        logger.warning("未知的优先级 '%s'，回退到事件原始优先级 %s", priority_name, event.priority.name)
        priority = event.priority

    if priority in (EventPriority.CRITICAL, EventPriority.HIGH, EventPriority.NORMAL):
        return "think"
    # LOW 优先级或 spam 意图跳过，idle 意图由 idle_ticks 阈值控制
    if intent == "idle":
        if idle_ticks >= idle_threshold:
            return "think"
        return "end"
    if priority == EventPriority.LOW or intent == "spam":
        logger.debug("跳过事件: intent=%s priority=%s", intent, priority.name)
        return "end"

    return "end"
