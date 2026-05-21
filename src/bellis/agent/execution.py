"""执行模块：负责将决策结果转化为实际动作输出。

本模块实现了 Agent 状态图中的 ACT 阶段，包括：
- 将 LiveResponse 转换为标准 Action 列表
- 通过 ActionMiddleware 链过滤和修改 Action
- 通过 OutputPipeline 和 OutputPlugin 分发执行
- 处理中断命令（人设切换、话题切换、强制回复等）
- ACT 完成后的路由决策
"""

from __future__ import annotations

import logging

from bellis.core.actions import Action
from bellis.core.enums import ActionType, CommandType, EmotionEnum, EventSource, MotionEnum
from bellis.core.models import TTSTask
from bellis.core.state import AgentState, get_context
from bellis.observability.otel import traced

logger = logging.getLogger(__name__)


def _response_to_actions(state: AgentState) -> list[Action]:
    """将 LiveResponse 转换为标准 Action 列表，供 OutputPlugin 消费。

    根据响应内容生成以下类型的 Action：
    - speak：文本语音输出（当响应包含文本时）。
    - set_expression：表情切换（当情绪非 neutral 时）。
    - set_motion：动作切换（当动作非 idle 时）。
    - reply_danmaku：弹幕回复（当事件包含用户名时）。

    Args:
        state: 当前 Agent 状态字典，需包含 "live_response" 键。

    Returns:
        转换后的 Action 列表，无响应时返回空列表。
    """
    response = state.get("live_response")
    if response is None:
        return []

    actions: list[Action] = []

    if response.text:
        actions.append(
            Action(
                type=ActionType.speak,
                text=response.text,
                emotion=response.emotion,
                target_user=response.target_user,
                tts_speed=response.tts_speed,
                priority=response.priority,
            )
        )

    if response.emotion and response.emotion != EmotionEnum.neutral:
        # 仅在情绪为非默认值时生成表情切换动作
        actions.append(
            Action(
                type=ActionType.set_expression,
                expression=response.emotion.value,
                emotion=response.emotion,
            )
        )

    if response.motion and response.motion != MotionEnum.idle:
        # 仅在动作为非默认值时生成动作切换指令
        actions.append(
            Action(
                type=ActionType.set_motion,
                motion=response.motion,
                motion_duration=response.motion_duration,
                emotion=response.emotion,
            )
        )

    event = state.get("current_event")
    if event is not None and hasattr(event, "user_name") and event.user_name:
        # 当事件来自具名用户时，生成弹幕回复动作
        actions.append(
            Action(
                type=ActionType.reply_danmaku,
                reply_text=response.text,
                target_user=event.user_name,
            )
        )

    return actions


@traced("bellis.node.act")
async def act(state: AgentState) -> dict:
    """执行动作：将决策结果分发到输出管道和插件。

    流程：
    1. 触发 pre_act 钩子。
    2. 若无 LiveResponse 则跳过执行。
    3. 构建 TTS 任务（流式模式下跳过，避免重复追加）。
    4. 将 LiveResponse 转换为 Action 列表。
    5. 通过 ActionMiddleware 链过滤/修改 Action。
    6. 通过 OutputPipeline 执行响应级别操作。
    7. 通过 OutputPlugin 逐个分发 Action（每个插件独立错误隔离）。
    8. 触发 post_act 钩子。

    Args:
        state: 当前 Agent 状态字典。

    Returns:
        包含 tts_queue、actions、state_version 的状态更新字典；
        无响应时返回空字典。
    """
    ctx = get_context(state)
    if ctx.hook_manager:
        state = await ctx.hook_manager.fire("pre_act", state)

    response = state.get("live_response")
    if response is None:
        result = {}
    else:
        # 流式模式下 TTS 已在 stream_think 中按句子推送，此处不再重复追加
        tts_queue = list(state.get("tts_queue", []))
        if not state.get("_streaming_tts_pushed"):
            tts_queue.append(
                TTSTask(
                    text=response.text,
                    speed=response.tts_speed,
                    emotion=response.emotion,
                    target_user=response.target_user,
                    priority=response.priority,
                )
            )

        actions = _response_to_actions(state)

        # 通过 ActionMiddleware 链过滤/修改 Action
        if ctx.pipeline is not None:
            filtered_actions: list[Action] = []
            for action in actions:
                processed = await ctx.pipeline.process_action(action)
                if processed is not None:
                    filtered_actions.append(processed)
            actions = filtered_actions

        # 通过 OutputPipeline 执行（带错误隔离）
        if ctx.pipeline is not None:
            try:
                await ctx.pipeline.execute(response)
            except Exception:
                logger.exception("OutputPipeline 执行失败")

        # 通过 OutputPlugin 分发 Action（每个插件独立错误隔离）
        for plugin in ctx.output_plugins:
            try:
                for action in actions:
                    await plugin.emit(action)
            except Exception:
                logger.exception("OutputPlugin %s 执行失败", plugin.name)

        result = {
            "tts_queue": tts_queue,
            "actions": actions,
            "state_version": state.get("state_version", 0) + 1,
        }

    if ctx.hook_manager:
        state = await ctx.hook_manager.fire("post_act", {**state, **result})
        result = {k: state[k] for k in result if k in state}

    return result


@traced("bellis.node.handle_interrupt")
async def handle_interrupt(state: AgentState) -> dict:
    """处理中断命令：根据命令类型更新 Agent 状态。

    支持的中断命令类型：
    - SWITCH_PERSONA：切换人设，记录目标人设名称。
    - SWITCH_TOPIC：切换话题，记录目标话题。
    - FORCE_REPLY：强制回复，标记中断动作为 force_reply。
    - INTERRUPT：暂停 Agent，设置 interrupt_flag 为 True。
    - RESUME：恢复 Agent，设置 interrupt_flag 为 False。

    Args:
        state: 当前 Agent 状态字典，需包含 "current_event" 键。

    Returns:
        包含 interrupt_flag、state_version、metrics 的状态更新字典；
        事件非命令类型时返回空字典。
    """
    event = state.get("current_event")
    if event is None or event.source != EventSource.COMMAND:
        return {}
    command_type = getattr(event, "command_type", "")
    payload = getattr(event, "payload", {})
    updates: dict = {
        "interrupt_flag": False,
        "state_version": state.get("state_version", 0) + 1,
    }
    metrics = dict(state.get("metrics") or {})

    if command_type == CommandType.SWITCH_PERSONA:
        persona_name = payload.get("name", "default")
        metrics["interrupt_action"] = f"switch_persona:{persona_name}"
    elif command_type == CommandType.SWITCH_TOPIC:
        metrics["interrupt_action"] = f"switch_topic:{payload.get('topic', '')}"
    elif command_type == CommandType.FORCE_REPLY:
        metrics["interrupt_action"] = "force_reply"
    elif command_type == CommandType.INTERRUPT:
        metrics["interrupt_action"] = "interrupt"
        updates["interrupt_flag"] = True
    elif command_type == CommandType.RESUME:
        metrics["interrupt_action"] = "resume"
        updates["interrupt_flag"] = False

    if metrics:
        updates["metrics"] = metrics
    return updates


def route_after_act(state: AgentState) -> str:
    """ACT 完成后路由：有更多事件则回到 PERCEIVE，否则结束本轮。

    Args:
        state: 当前 Agent 状态字典，需包含 "event_queue" 键。

    Returns:
        路由目标节点名称："perceive"（继续处理事件）或 "end"（结束本轮）。
    """
    event_queue = state.get("event_queue", [])
    if event_queue:
        return "perceive"
    return "end"
