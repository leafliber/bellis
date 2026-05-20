"""状态图模块：构建 Agent 的主循环状态机。

使用 LangGraph 定义 Agent 的核心执行流程，包括事件出队、感知、
思考（同步/流式）、执行和中断处理等节点的连接与路由。
"""

from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from bellis.agent.execution import act, handle_interrupt, route_after_act
from bellis.agent.perception import dequeue_event, perceive, route_after_perception
from bellis.core.state import AgentState


def build_main_graph(streaming: bool = False):
    """
    构建循环主图：
    START → dequeue_event → perceive ──(should_respond?)──→ think → act ──→ perceive
                                    │                              ↑
                                    ├─(idle≥threshold)────────────→↑
                                    ├─(interrupt)→ handle_interrupt → END
                                    └─(end)→ END
    act 完成后若有更多事件则回到 perceive，否则结束本轮。

    Args:
        streaming: 是否启用流式思考模式。为 True 时 think 节点使用 stream_think，
            实现边生成边推送 TTS 的低延迟体验；为 False 时使用同步 think。

    Returns:
        编译后的 LangGraph 状态图实例，可直接调用 invoke/run。
    """
    # 延迟导入避免循环依赖
    from bellis.agent.decision import stream_think, think

    graph = StateGraph(AgentState)

    graph.add_node("dequeue_event", dequeue_event)
    graph.add_node("perceive", perceive)
    graph.add_node("think", stream_think if streaming else think)  # 根据模式选择同步/流式思考
    graph.add_node("act", act)
    graph.add_node("handle_interrupt", handle_interrupt)

    graph.add_edge(START, "dequeue_event")
    graph.add_edge("dequeue_event", "perceive")

    # perceive 后的条件路由：根据感知结果决定进入 think、interrupt 还是结束
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

    # act 后的条件路由：有更多事件则继续处理，否则结束本轮
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
