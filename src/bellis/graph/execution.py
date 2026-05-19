from __future__ import annotations

from bellis.core.actions import Action
from bellis.core.enums import ActionType, EventSource
from bellis.core.models import TTSTask
from bellis.core.state import AgentState
from bellis.plugins.hooks import HookManager


def _response_to_actions(state: AgentState) -> list[Action]:
    """将 LiveResponse 转换为标准 Action 列表，供 OutputPlugin 消费。"""
    response = state.get("live_response")
    if response is None:
        return []

    actions: list[Action] = []

    # 说话动作 → TTS
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

    # 表情动作 → Live2D
    if response.emotion:
        actions.append(
            Action(
                type=ActionType.set_expression,
                expression=response.emotion.value,
                emotion=response.emotion,
            )
        )

    # 动作 → Live2D
    if response.motion:
        actions.append(
            Action(
                type=ActionType.set_motion,
                motion=response.motion,
                motion_duration=response.motion_duration,
                emotion=response.emotion,
            )
        )

    # 弹幕回复
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
    hook_mgr: HookManager | None = state.get("metrics", {}).get("_hook_manager")
    if hook_mgr:
        state = await hook_mgr.fire("pre_act", state)

    response = state.get("live_response")
    if response is None:
        result = {}
    else:
        # 生成 TTS 任务
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

        # 转换为标准 Action 列表
        actions = _response_to_actions(state)

        # 通过 OutputPipeline 执行（如果已注册）
        pipeline = state.get("metrics", {}).get("_pipeline")
        if pipeline is not None:
            await pipeline.execute(response)

        # 通过 OutputPlugin 分发 Action（如果已注册）
        output_plugins = state.get("metrics", {}).get("_output_plugins", [])
        for plugin in output_plugins:
            for action in actions:
                await plugin.emit(action)

        result = {
            "tts_queue": tts_queue,
            "actions": actions,
            "state_version": state.get("state_version", 0) + 1,
        }

    if hook_mgr:
        state = await hook_mgr.fire("post_act", {**state, **result})
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
    if command_type == "switch_persona":
        persona_name = payload.get("name", "default")
        updates["metrics"] = dict(state.get("metrics") or {})
        updates["metrics"]["interrupt_action"] = f"switch_persona:{persona_name}"
    elif command_type == "switch_topic":
        updates["metrics"] = dict(state.get("metrics") or {})
        updates["metrics"]["interrupt_action"] = f"switch_topic:{payload.get('topic', '')}"
    return updates


def route_after_act(state: AgentState) -> str:
    """ACT 完成后路由：有更多事件则回到 PERCEIVE，否则结束本轮。"""
    event_queue = state.get("event_queue", [])
    if event_queue:
        return "perceive"
    return "end"
