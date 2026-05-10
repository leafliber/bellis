from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from bellis.core.state import AgentState
from bellis.graph.decision import decide
from bellis.graph.execution import execute, handle_interrupt, route_after_perception
from bellis.graph.perception import dequeue_event, perceive, throttle


def build_main_graph(streaming: bool = False):
    graph = StateGraph(AgentState)

    graph.add_node("dequeue_event", dequeue_event)
    graph.add_node("perceive", perceive)
    graph.add_node("throttle", throttle)
    graph.add_node("decide", decide)
    graph.add_node("execute", execute)
    graph.add_node("handle_interrupt", handle_interrupt)

    graph.add_edge(START, "dequeue_event")
    graph.add_edge("dequeue_event", "perceive")

    graph.add_conditional_edges(
        "perceive",
        route_after_perception,
        {
            "decision": "decide",
            "interrupt": "handle_interrupt",
            "end": END,
        },
    )

    graph.add_edge("decide", "execute")
    graph.add_edge("execute", END)
    graph.add_edge("handle_interrupt", END)
    graph.add_edge("throttle", END)

    return graph.compile()
