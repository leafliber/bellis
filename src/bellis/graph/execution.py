from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from bellis.core.enums import EventSource
from bellis.core.models import TTSTask
from bellis.core.state import AgentState


def execute(state: AgentState) -> dict:
    response = state.get("live_response")
    if response is None:
        return {}
    pipeline = state.get("metrics", {}).get("_pipeline")
    if pipeline is not None:
        pipeline.execute(response)
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
    return {
        "tts_queue": tts_queue,
        "state_version": state.get("state_version", 0) + 1,
    }


def handle_interrupt(state: AgentState) -> dict:
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


def route_after_perception(state: AgentState) -> str:
    event = state.get("current_event")
    if event is None:
        return "end"
    if state.get("interrupt_flag") and event.source == EventSource.COMMAND:
        return "interrupt"
    metrics = state.get("metrics") or {}
    perception = metrics.get("perception") or {}
    priority_name = perception.get("reassessed_priority", event.priority.name)
    intent = perception.get("intent", "")
    from bellis.core.enums import EventPriority
    try:
        priority = EventPriority[priority_name]
    except KeyError:
        priority = event.priority
    if priority in (EventPriority.CRITICAL, EventPriority.HIGH, EventPriority.NORMAL):
        return "decision"
    if priority == EventPriority.LOW or intent == "spam":
        return "end"
    return "decision"


def build_execution_graph() -> StateGraph:
    graph = StateGraph(AgentState)
    graph.add_node("execute", execute)
    graph.add_edge(START, "execute")
    graph.add_edge("execute", END)
    return graph.compile()
