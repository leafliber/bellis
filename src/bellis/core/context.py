"""AgentContext — Agent 运行时上下文，替代在 AgentState.metrics 中传递框架对象的做法。

AgentState 是 LangGraph 的状态字典，只应包含业务数据。
框架内部引用（HookManager、OutputPlugin 列表等）通过 AgentContext 传递。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from bellis.plugin.base import OutputPlugin
from bellis.plugin.hooks import HookManager
from bellis.runtime.middleware import OutputPipeline


@dataclass
class AgentContext:
    """Agent 运行时上下文，由 BellisApp 创建并注入到各节点。"""

    hook_manager: HookManager = field(default_factory=HookManager)
    output_plugins: list[OutputPlugin] = field(default_factory=list)
    pipeline: OutputPipeline | None = None
    extra_tools: list = field(default_factory=list)
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None
    compat_mode: bool = False
    idle_threshold: int = 5
    idle_monitor_interval: float = 2.0

    @property
    def effective_model(self) -> str:
        """返回实际使用的模型名称。"""
        return self.model or "openai:gpt-4o"
