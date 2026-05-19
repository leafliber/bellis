from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from bellis.core.state import AgentState
from bellis.graph.execution import act, handle_interrupt, route_after_act
from bellis.graph.perception import dequeue_event, perceive, route_after_perception


def build_main_graph(streaming: bool = False):
    """
    构建循环主图：
    START → dequeue_event → perceive ──(should_respond?)──→ think → act ──→ perceive
                                    │                              ↑
                                    ├─(idle≥threshold)────────────→↑
                                    ├─(interrupt)→ handle_interrupt → END
                                    └─(end)→ END
    act 完成后若有更多事件则回到 perceive，否则结束本轮。
    """
    from bellis.graph.decision import stream_think, think

    graph = StateGraph(AgentState)

    graph.add_node("dequeue_event", dequeue_event)
    graph.add_node("perceive", perceive)
    graph.add_node("think", stream_think if streaming else think)
    graph.add_node("act", act)
    graph.add_node("handle_interrupt", handle_interrupt)

    graph.add_edge(START, "dequeue_event")
    graph.add_edge("dequeue_event", "perceive")

    graph.add_conditional_edges(
        "perceive",
        route_after_perception,
        {
            "think": "think",
            "interrupt": "handle_interrupt",
            "end": END,
        },
    )

    graph.add_edge("think", "act")

    # ACT 完成后：有更多事件回到 perceive（循环），否则结束
    graph.add_conditional_edges(
        "act",
        route_after_act,
        {
            "perceive": "dequeue_event",
            "end": END,
        },
    )

    graph.add_edge("handle_interrupt", END)

    return graph.compile()
