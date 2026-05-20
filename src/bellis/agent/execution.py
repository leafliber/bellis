from __future__ import annotations

import logging

from bellis.core.actions import Action
from bellis.core.context import AgentContext
from bellis.core.enums import ActionType, CommandType, EventSource
from bellis.core.models import TTSTask
from bellis.core.state import AgentState

logger = logging.getLogger(__name__)


def _get_context(state: AgentState) -> AgentContext:
    ctx = state.get("_context")
    if ctx is None:
        raise RuntimeError("AgentState 中缺少 _context，请确保 BellisApp 已正确初始化")
    return ctx


def _response_to_actions(state: AgentState) -> list[Action]:
    """将 LiveResponse 转换为标准 Action 列表，供 OutputPlugin 消费。"""
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

    if response.emotion:
        actions.append(
            Action(
                type=ActionType.set_expression,
                expression=response.emotion.value,
                emotion=response.emotion,
            )
        )

    if response.motion:
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
        actions.append(
            Action(
                type=ActionType.reply_danmaku,
                reply_text=response.text,
                target_user=event.user_name,
            )
        )

    return actions


async def act(state: AgentState) -> dict:
    ctx = _get_context(state)
    if ctx.hook_manager:
        state = await ctx.hook_manager.fire("pre_act", state)

    response = state.get("live_response")
    if response is None:
        result = {}
    else:
        tts_queue = list(state.get("tts_queue", []))
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


async def handle_interrupt(state: AgentState) -> dict:
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

    if command_type == CommandType.SWITCH_PERSONA.value or command_type == "switch_persona":
        persona_name = payload.get("name", "default")
        metrics["interrupt_action"] = f"switch_persona:{persona_name}"
    elif command_type == CommandType.SWITCH_TOPIC.value or command_type == "switch_topic":
        metrics["interrupt_action"] = f"switch_topic:{payload.get('topic', '')}"
    elif command_type == CommandType.FORCE_REPLY.value or command_type == "force_reply":
        metrics["interrupt_action"] = "force_reply"
        updates["interrupt_flag"] = False
    elif command_type == CommandType.INTERRUPT.value or command_type == "interrupt":
        metrics["interrupt_action"] = "interrupt"
        updates["interrupt_flag"] = True
    elif command_type == CommandType.RESUME.value or command_type == "resume":
        metrics["interrupt_action"] = "resume"
        updates["interrupt_flag"] = False

    if metrics:
        updates["metrics"] = metrics
    return updates


def route_after_act(state: AgentState) -> str:
    """ACT 完成后路由：有更多事件则回到 PERCEIVE，否则结束本轮。"""
    event_queue = state.get("event_queue", [])
    if event_queue:
        return "perceive"
    return "end"
