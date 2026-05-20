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
    """Agent 运行时上下文，由 BellisApp 创建并注入到各节点。

    与 AgentState（纯业务数据）不同，AgentContext 承载框架内部引用，
    如 HookManager、OutputPlugin 列表、输出管线等，避免将框架对象
    混入 LangGraph 的状态字典。

    Attributes:
        hook_manager: 钩子管理器，负责生命周期回调的分发。
        output_plugins: 输出插件列表，用于将动作分发到不同通道。
        pipeline: 输出管线，对动作进行中间件处理。
        timeline_sync: 时间线同步器，协调 TTS 与动作的时序。
        extra_tools: 额外工具列表，供 LLM 调用。
        base_url: LLM API 基础地址。
        api_key: LLM API 密钥。
        model: 指定的模型名称，为 None 时使用默认模型。
        compat_mode: 兼容模式标记，启用时降级部分功能以保证兼容性。
        idle_threshold: 空闲判定阈值（连续空闲 tick 数）。
        idle_monitor_interval: 空闲监控轮询间隔（秒）。
    """

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
