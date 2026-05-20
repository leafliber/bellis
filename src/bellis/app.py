from __future__ import annotations

import asyncio
import logging
import signal
import sys

from bellis.agent.graph import build_main_graph
from bellis.config.loader import ConfigCenter
from bellis.core.context import AgentContext
from bellis.core.events import IdleEvent
from bellis.core.models import EmotionState, SceneContext
from bellis.core.state import AgentState
from bellis.observability.tracing import Tracer
from bellis.plugin.registry import PluginRegistry
from bellis.runtime.bus import EventBus
from bellis.runtime.executors import Live2DExecutor, TTSExecutor
from bellis.runtime.sync import TimelineSync

logger = logging.getLogger(__name__)


class BellisApp:
    """Bellis 主应用：加载插件 → 编译图 → 跑主循环。"""

    def __init__(
        self,
        config: ConfigCenter | None = None,
        registry: PluginRegistry | None = None,
        streaming: bool = False,
    ) -> None:
        self._config = config or ConfigCenter()
        self._registry = registry or PluginRegistry()
        self._streaming = streaming
        self._running = False
        self._graph = None
        self._event_bus: EventBus | None = None
        self._tracer = Tracer()
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

    @property
    def config(self) -> ConfigCenter:
        return self._config

    @property
    def registry(self) -> PluginRegistry:
        return self._registry

    @property
    def event_bus(self) -> EventBus | None:
        return self._event_bus

    @property
    def context(self) -> AgentContext:
        return self._context

    def setup_defaults(self) -> None:
        """注册默认的 Console 插件（用于调试）。"""
        from plugins.console import ConsoleInputPlugin, ConsoleOutputPlugin

        self._registry.register_input(ConsoleInputPlugin())
        self._registry.register_output(ConsoleOutputPlugin())
        # 同步 context 中的 output_plugins 引用
        self._context.output_plugins = self._registry.outputs

    def _build_timeline_sync(self) -> TimelineSync | None:
        """从已注册的 OutputPlugin 中提取 TTSExecutor 和 Live2DExecutor，构建 TimelineSync。"""
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
        """启动应用：初始化 EventBus → 启动所有插件 → 编译图 → 进入主循环。"""
        self._running = True
        self._event_bus = EventBus(maxsize=self._config.platform.max_queue_size)

        # 启动所有插件
        await self._registry.start_all()

        # 构建 TimelineSync（需要已注册的插件实例）
        self._context.timeline_sync = self._build_timeline_sync()

        # 编译图
        self._graph = build_main_graph(streaming=self._streaming)

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
            await self._registry.stop_all()

    async def _collect_events(self) -> None:
        """从所有 InputPlugin 收集事件并推入 EventBus。"""
        tasks = []
        for plugin in self._registry.inputs:
            tasks.append(asyncio.create_task(self._collect_from_plugin(plugin)))
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _collect_from_plugin(self, plugin) -> None:
        """从单个 InputPlugin 持续收集事件。"""
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
        """监控空闲状态，当长时间无事件时注入 IdleEvent。"""
        while self._running:
            await asyncio.sleep(self._context.idle_monitor_interval)
            if self._event_bus and self._event_bus.queue_size == 0:
                idle_event = IdleEvent(content="idle_tick")
                await self._event_bus.publish(idle_event)

    async def _main_loop(self) -> None:
        """主循环：从 EventBus 取事件 → 调用图 → 处理结果。"""
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

            # 调用图（带异常捕获，防止单次失败终止主循环）
            with self._tracer.span("process_event", {"source": event.source.value}):
                try:
                    result = await self._graph.ainvoke(state)
                except Exception:
                    logger.exception("Graph 执行失败，跳过本轮事件")
                    continue

            # 合并结果到 state
            if result:
                # 保留 _context 引用
                ctx = state.get("_context")
                state = dict(result)
                if ctx is not None:
                    state["_context"] = ctx

    async def stop(self) -> None:
        """停止应用：设置标志位，等待主循环退出。"""
        self._running = False


def main() -> None:
    """CLI 入口。"""
    app = BellisApp()
    app.setup_defaults()

    loop = asyncio.new_event_loop()

    def _shutdown():
        loop.call_soon_threadsafe(lambda: asyncio.ensure_future(app.stop()))

    signal.signal(signal.SIGINT, lambda *_: _shutdown())
    if sys.platform != "win32":
        signal.signal(signal.SIGTERM, lambda *_: _shutdown())

    print("Bellis - Live Streaming AI Agent Framework")
    print("输入弹幕内容与 AI 互动，Ctrl+C 退出")
    print("-" * 40)

    try:
        loop.run_until_complete(app.start())
    except KeyboardInterrupt:
        pass
    finally:
        loop.close()


if __name__ == "__main__":
    main()
