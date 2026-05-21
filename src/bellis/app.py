"""Bellis 主应用模块 — 应用生命周期管理与主循环入口。

本模块实现 BellisApp 类，负责组装配置、插件注册表、事件总线、
追踪器等核心组件，并驱动 Agent 主循环的运行。同时提供 CLI 入口函数 main()。
"""

from __future__ import annotations

import asyncio
import logging
import signal
import sys

from bellis.agent.graph import build_main_graph
from bellis.config.loader import ConfigCenter
from bellis.core.context import AgentContext
from bellis.core.events import DanmakuEvent, IdleEvent
from bellis.core.logging import setup_logging
from bellis.core.models import EmotionState, SceneContext
from bellis.core.state import AgentState
from bellis.gateway import Gateway, GatewayCallbacks
from bellis.observability.tracing import Tracer
from bellis.plugin.registry import PluginRegistry
from bellis.runtime.bus import EventBus
from bellis.runtime.executors import Live2DExecutor, TTSExecutor
from bellis.runtime.sync import TimelineSync

logger = logging.getLogger(__name__)


class BellisApp(GatewayCallbacks):
    """Bellis 主应用：加载插件 → 编译图 → 跑主循环。

    负责管理应用的完整生命周期，包括插件启动/停止、事件收集、
    空闲检测、主循环驱动及优雅关闭。同时实现 GatewayCallbacks 接口，
    处理前端通过 Gateway 发来的控制指令。

    Attributes:
        _config: 配置中心实例。
        _registry: 插件注册表实例。
        _streaming: 是否启用流式输出模式。
        _running: 应用运行标志位。
        _graph: 编译后的主循环图。
        _event_bus: 事件总线实例。
        _tracer: 链路追踪器实例。
        _context: Agent 上下文，贯穿主循环的共享依赖容器。
        _gateway: 前端通信网关实例。
    """

    def __init__(
        self,
        config: ConfigCenter | None = None,
        registry: PluginRegistry | None = None,
        streaming: bool = False,
        gateway_host: str = "localhost",
        gateway_port: int = 8765,
        enable_gateway: bool = False,
    ) -> None:
        self._config = config or ConfigCenter()
        self._registry = registry or PluginRegistry()
        self._streaming = streaming
        self._running = False
        self._graph = None
        self._event_bus: EventBus | None = None
        self._tracer = Tracer()
        # 构建 Agent 上下文，将插件注册表和配置中心的依赖注入其中
        self._context = AgentContext(
            hook_manager=self._registry.hook_manager,
            output_plugins=self._registry.outputs,
            extra_tools=self._registry.collect_tools(),
            model=self._config.model.primary_model,
            base_url=self._config.model.base_url,
            api_key=self._config.model.api_key,
            compat_mode=self._config.model.compat_mode,
            idle_threshold=self._config.platform.idle_threshold,
            idle_monitor_interval=self._config.platform.idle_monitor_interval,
        )
        # 前端通信网关，默认不启用
        self._gateway: Gateway | None = None
        if enable_gateway:
            self._gateway = Gateway(
                callbacks=self,
                host=gateway_host,
                port=gateway_port,
            )

    @property
    def config(self) -> ConfigCenter:
        """返回配置中心实例。"""
        return self._config

    @property
    def registry(self) -> PluginRegistry:
        """返回插件注册表实例。"""
        return self._registry

    @property
    def event_bus(self) -> EventBus | None:
        """返回事件总线实例，应用未启动时为 None。"""
        return self._event_bus

    @property
    def context(self) -> AgentContext:
        """返回 Agent 上下文实例。"""
        return self._context

    @property
    def gateway(self) -> Gateway | None:
        """返回前端通信网关实例，未启用时为 None。"""
        return self._gateway

    # ─── GatewayCallbacks 实现 ─────────────────────────────────────

    async def on_command(self, text: str) -> None:
        """前端弹幕 → 注入 EventBus。"""
        event = DanmakuEvent(content=text, user_name="你", user_level=10, fan_badge="铁粉")
        if self._event_bus:
            await self._event_bus.publish(event)

    async def on_start_agent(self) -> None:
        """前端请求启动 Agent。"""
        if not self._running:
            asyncio.create_task(self.start())

    async def on_stop_agent(self) -> None:
        """前端请求停止 Agent。"""
        await self.stop()

    async def on_switch_persona(self, name: str) -> None:
        """前端请求切换人设。"""
        self._config.switch_persona(name)

    def setup_defaults(self) -> None:
        """注册默认的 Console 插件（用于调试）。"""
        from plugins.console import ConsoleInputPlugin, ConsoleOutputPlugin

        self._registry.register_input(ConsoleInputPlugin())
        self._registry.register_output(ConsoleOutputPlugin())
        # 同步 context 中的 output_plugins 引用
        self._context.output_plugins = self._registry.outputs

    def _build_timeline_sync(self) -> TimelineSync | None:
        """从已注册的 OutputPlugin 中提取 TTSExecutor 和 Live2DExecutor，构建 TimelineSync。

        仅当同时找到 TTS 和 Live2D 驱动时才创建 TimelineSync，
        否则返回 None（表示不需要时间线同步）。

        Returns:
            TimelineSync 实例或 None。
        """
        tts_driver: TTSExecutor | None = None
        live2d_driver: Live2DExecutor | None = None
        for plugin in self._registry.outputs:
            if hasattr(plugin, "driver"):
                if isinstance(plugin.driver, TTSExecutor) and tts_driver is None:
                    tts_driver = plugin.driver
                if isinstance(plugin.driver, Live2DExecutor) and live2d_driver is None:
                    live2d_driver = plugin.driver
        if tts_driver is not None and live2d_driver is not None:
            return TimelineSync(tts=tts_driver, live2d=live2d_driver)
        return None

    def _build_initial_state(self) -> AgentState:
        """构建 Agent 主循环的初始状态字典。

        Returns:
            包含所有初始字段的 AgentState 字典。
        """
        persona = self._config.get_active_persona()
        return {
            "event_queue": [],
            "current_event": None,
            "scene_context": SceneContext(),
            "emotion_state": EmotionState(),
            "action_history": [],
            "live_response": None,
            "actions": [],
            "persona": persona,
            "state_version": 0,
            "interrupt_flag": False,
            "tts_queue": [],
            "idle_ticks": 0,
            "metrics": {},
            "_context": self._context,
        }

    async def start(self) -> None:
        """启动应用：初始化 EventBus → 启动所有插件 → 编译图 → 进入主循环。

        启动后会创建事件收集和空闲检测两个后台任务，
        主循环退出后自动取消后台任务并停止所有插件。
        若 Gateway 已启用，则同时启动 WebSocket 服务。
        """
        self._running = True
        self._event_bus = EventBus(maxsize=self._config.platform.max_queue_size)

        # 启动所有插件
        await self._registry.start_all()

        # 构建 TimelineSync（需要已注册的插件实例）
        self._context.timeline_sync = self._build_timeline_sync()

        # 编译图
        self._graph = build_main_graph(streaming=self._streaming)

        # 启动 Gateway
        if self._gateway is not None:
            await self._gateway.start()

        # 启动事件收集任务
        collect_task = asyncio.create_task(self._collect_events())

        # 启动空闲检测任务
        idle_task = asyncio.create_task(self._idle_monitor())

        # 主循环
        try:
            await self._main_loop()
        except asyncio.CancelledError:
            pass
        finally:
            self._running = False
            collect_task.cancel()
            idle_task.cancel()
            # 停止 Gateway
            if self._gateway is not None:
                await self._gateway.stop()
            await self._registry.stop_all()

    async def _collect_events(self) -> None:
        """从所有 InputPlugin 收集事件并推入 EventBus。

        为每个 InputPlugin 创建独立的异步收集任务，
        使用 gather 并发执行，单个插件异常不会影响其他插件。
        """
        tasks = []
        for plugin in self._registry.inputs:
            tasks.append(asyncio.create_task(self._collect_from_plugin(plugin)))
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _collect_from_plugin(self, plugin) -> None:
        """从单个 InputPlugin 持续收集事件。

        持续监听插件的 listen() 异步迭代器，将事件发布到 EventBus。
        当应用停止或任务被取消时退出循环。

        Args:
            plugin: 输入插件实例。
        """
        try:
            async for event in plugin.listen():
                if not self._running:
                    break
                if self._event_bus:
                    await self._event_bus.publish(event)
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("InputPlugin %s 收集事件异常，任务终止", plugin.name)

    async def _idle_monitor(self) -> None:
        """监控空闲状态，当长时间无事件时注入 IdleEvent。

        按配置的 idle_monitor_interval 周期性检查事件总线，
        若队列为空则发布 IdleEvent 以触发空闲处理逻辑。
        """
        while self._running:
            await asyncio.sleep(self._context.idle_monitor_interval)
            if self._event_bus and self._event_bus.queue_size == 0:
                idle_event = IdleEvent(content="idle_tick")
                await self._event_bus.publish(idle_event)

    async def _main_loop(self) -> None:
        """主循环：从 EventBus 取事件 → 调用图 → 处理结果。

        每轮循环从 EventBus 订阅一个事件，将其加入状态的事件队列后
        调用编译后的图进行推理，最后将图输出合并回状态。
        单次图执行失败不会终止主循环，仅跳过本轮事件。
        若 Gateway 已启用，则每轮推送事件、状态和响应到前端。
        """
        if not self._event_bus:
            return

        state = self._build_initial_state()

        async for event in self._event_bus.subscribe():
            if not self._running:
                break

            # 将事件加入队列
            event_queue = list(state.get("event_queue", []))
            event_queue.append(event)

            # 更新 state
            state["event_queue"] = event_queue
            state["current_event"] = event
            state["idle_ticks"] = 0

            # 推送原始事件到前端
            if self._gateway is not None:
                await self._gateway.broadcast_event(event)

            # 调用图（带异常捕获，防止单次失败终止主循环）
            with self._tracer.span("process_event", {"source": event.source.value}):
                try:
                    result = await self._graph.ainvoke(state)
                except Exception:
                    logger.exception("Graph 执行失败，跳过本轮事件")
                    continue

            # 合并结果到 state
            if result:
                # 保留 _context 引用，避免图输出覆盖上下文
                ctx = state.get("_context")
                state = dict(result)
                if ctx is not None:
                    state["_context"] = ctx

            # 推送状态和响应到前端
            if self._gateway is not None:
                await self._gateway.broadcast_state(state)
                await self._gateway.broadcast_response(state)

    async def stop(self) -> None:
        """停止应用：设置标志位，等待主循环退出。"""
        self._running = False


def main() -> None:
    """CLI 入口。

    初始化日志、创建默认应用实例、注册信号处理器，
    然后在事件循环中启动应用。支持 Ctrl+C 优雅退出。
    """
    setup_logging()

    app = BellisApp()
    app.setup_defaults()

    loop = asyncio.new_event_loop()

    def _shutdown():
        """信号处理回调：线程安全地调度应用停止。"""
        loop.call_soon_threadsafe(lambda: asyncio.ensure_future(app.stop()))

    signal.signal(signal.SIGINT, lambda *_: _shutdown())
    if sys.platform != "win32":
        # Windows 不支持 SIGTERM 信号
        signal.signal(signal.SIGTERM, lambda *_: _shutdown())

    logger.info("Bellis - Live Streaming AI Agent Framework")
    logger.info("输入弹幕内容与 AI 互动，Ctrl+C 退出")

    try:
        loop.run_until_complete(app.start())
    except KeyboardInterrupt:
        pass
    finally:
        loop.close()


if __name__ == "__main__":
    main()
