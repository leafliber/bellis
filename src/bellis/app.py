from __future__ import annotations

import asyncio
import signal

from bellis.config.loader import ConfigCenter
from bellis.core.events import IdleEvent
from bellis.core.models import EmotionState, SceneContext
from bellis.core.state import AgentState
from bellis.graph.main import build_main_graph
from bellis.input.bus import EventBus
from bellis.observability.tracing import Tracer
from bellis.plugins.console import ConsoleInputPlugin, ConsoleOutputPlugin
from bellis.plugins.registry import PluginRegistry


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

    @property
    def config(self) -> ConfigCenter:
        return self._config

    @property
    def registry(self) -> PluginRegistry:
        return self._registry

    @property
    def event_bus(self) -> EventBus | None:
        return self._event_bus

    def setup_defaults(self) -> None:
        """注册默认的 Console 插件（用于调试）。"""
        self._registry.register_input(ConsoleInputPlugin())
        self._registry.register_output(ConsoleOutputPlugin())

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
            "metrics": {
                "_hook_manager": self._registry.hook_manager,
                "_output_plugins": self._registry.outputs,
                "_extra_tools": self._registry.collect_tools(),
            },
        }

    async def start(self) -> None:
        """启动应用：初始化 EventBus → 启动输入插件 → 编译图 → 进入主循环。"""
        self._running = True
        self._event_bus = EventBus(maxsize=self._config.platform.max_queue_size)

        # 启动输入插件
        await self._registry.start_inputs()

        # 启动平台插件
        await self._registry.start_platforms()

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
            await self._registry.stop_inputs()
            await self._registry.stop_platforms()

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

    async def _idle_monitor(self) -> None:
        """监控空闲状态，当长时间无事件时注入 IdleEvent。"""
        while self._running:
            await asyncio.sleep(2.0)
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
            state["current_event"] = None
            state["idle_ticks"] = 0

            # 调用图
            with self._tracer.span("process_event", {"source": event.source.value}):
                result = await self._graph.ainvoke(state)

            # 合并结果到 state（保留 metrics 中的内部引用）
            old_metrics = state.get("metrics", {})
            state = dict(result) if result else state
            new_metrics = state.get("metrics", {})
            # 保留内部引用
            for key in ("_hook_manager", "_output_plugins", "_extra_tools"):
                if key in old_metrics and key not in new_metrics:
                    new_metrics[key] = old_metrics[key]
            state["metrics"] = new_metrics

    async def stop(self) -> None:
        self._running = False


def main() -> None:
    """CLI 入口。"""
    app = BellisApp()
    app.setup_defaults()

    loop = asyncio.new_event_loop()

    def _shutdown():
        loop.call_soon_threadsafe(lambda: asyncio.ensure_future(app.stop()))

    signal.signal(signal.SIGINT, lambda *_: _shutdown())
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
