"""AgentContext — Agent 运行时上下文，替代在 AgentState.metrics 中传递框架对象的做法。

AgentState 是 LangGraph 的状态字典，只应包含业务数据。
框架内部引用（HookManager、OutputPlugin 列表等）通过 AgentContext 传递。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from bellis.plugin.base import OutputPlugin
    from bellis.plugin.hooks import HookManager
    from bellis.runtime.middleware import OutputPipeline
    from bellis.runtime.sync import TimelineSync


@dataclass
class AgentContext:
    """Agent 运行时上下文，由 BellisApp 创建并注入到各节点。"""

    hook_manager: HookManager = field(default_factory=lambda: _default_hook_manager())
    output_plugins: list[OutputPlugin] = field(default_factory=list)
    pipeline: OutputPipeline | None = None
    timeline_sync: TimelineSync | None = None
    extra_tools: list[Any] = field(default_factory=list)
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


def _default_hook_manager():
    """延迟导入 HookManager 以避免 core 层对 plugin 层的运行时依赖。"""
    from bellis.plugin.hooks import HookManager
    return HookManager()
