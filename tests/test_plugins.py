import pytest

from bellis.core.actions import Action
from bellis.core.enums import ActionType, EmotionEnum
from bellis.core.events import LiveEvent
from bellis.core.state import AgentState
from bellis.plugins.base import HookPlugin, InputPlugin, OutputPlugin, PlatformPlugin, ToolPlugin
from bellis.plugins.console import ConsoleOutputPlugin
from bellis.plugins.hooks import HookManager
from bellis.plugins.registry import PluginRegistry


class TestHookManager:
    @pytest.mark.asyncio
    async def test_register_and_fire(self):
        mgr = HookManager()
        calls = []

        async def hook(state: AgentState) -> AgentState:
            calls.append("pre_think")
            return state

        mgr.register("pre_think", hook)
        state: AgentState = {"metrics": {}}
        result = await mgr.fire("pre_think", state)
        assert calls == ["pre_think"]
        assert result is state

    @pytest.mark.asyncio
    async def test_fire_modifies_state(self):
        mgr = HookManager()

        async def add_marker(state: AgentState) -> AgentState:
            metrics = dict(state.get("metrics", {}))
            metrics["marked"] = True
            state["metrics"] = metrics
            return state

        mgr.register("post_act", add_marker)
        state: AgentState = {"metrics": {}}
        result = await mgr.fire("post_act", state)
        assert result["metrics"]["marked"] is True

    @pytest.mark.asyncio
    async def test_fire_unknown_point_raises(self):
        mgr = HookManager()
        with pytest.raises(ValueError):
            mgr.register("unknown_point", lambda s: s)

    @pytest.mark.asyncio
    async def test_clear(self):
        mgr = HookManager()

        async def hook(state: AgentState) -> AgentState:
            return state

        mgr.register("pre_perceive", hook)
        mgr.clear()
        state: AgentState = {}
        result = await mgr.fire("pre_perceive", state)
        assert result == {}


class TestPluginRegistry:
    def test_register_input(self):
        registry = PluginRegistry()

        class FakeInput(InputPlugin):
            async def listen(self):
                yield LiveEvent(content="test")

            async def start(self):
                pass

            async def stop(self):
                pass

        plugin = FakeInput()
        registry.register_input(plugin)
        assert len(registry.inputs) == 1

    def test_register_output(self):
        registry = PluginRegistry()

        class FakeOutput(OutputPlugin):
            async def emit(self, action: Action):
                pass

        plugin = FakeOutput()
        registry.register_output(plugin)
        assert len(registry.outputs) == 1

    def test_register_platform(self):
        registry = PluginRegistry()

        class FakePlatform(PlatformPlugin):
            async def start_stream(self):
                pass

            async def stop_stream(self):
                pass

            async def get_room_info(self):
                return {}

        plugin = FakePlatform()
        registry.register_platform(plugin)
        assert len(registry.platforms) == 1

    def test_register_tool(self):
        registry = PluginRegistry()

        class FakeTool(ToolPlugin):
            def get_tools(self):
                return [lambda: "tool"]

        plugin = FakeTool()
        registry.register_tool(plugin)
        assert len(registry.tools) == 1
        tools = registry.collect_tools()
        assert len(tools) == 1

    def test_register_hook(self):
        registry = PluginRegistry()

        class FakeHook(HookPlugin):
            def register_hooks(self, hook_mgr: HookManager):
                async def hook(state):
                    return state

                hook_mgr.register("pre_think", hook)

        plugin = FakeHook()
        registry.register_hook(plugin)
        assert len(registry.hook_manager._hooks["pre_think"]) == 1

    def test_chained_registration(self):
        registry = PluginRegistry()

        class FakeOutput(OutputPlugin):
            async def emit(self, action: Action):
                pass

        registry.register_output(FakeOutput()).register_output(FakeOutput())
        assert len(registry.outputs) == 2


class TestConsoleOutputPlugin:
    @pytest.mark.asyncio
    async def test_emit_speak(self, capsys):
        plugin = ConsoleOutputPlugin()
        action = Action(type=ActionType.speak, text="你好", emotion=EmotionEnum.happy)
        await plugin.emit(action)
        captured = capsys.readouterr()
        assert "你好" in captured.out
        assert "happy" in captured.out

    @pytest.mark.asyncio
    async def test_emit_expression(self, capsys):
        plugin = ConsoleOutputPlugin()
        action = Action(type=ActionType.set_expression, expression="happy")
        await plugin.emit(action)
        captured = capsys.readouterr()
        assert "表情" in captured.out

    @pytest.mark.asyncio
    async def test_emit_motion(self, capsys):
        from bellis.core.enums import MotionEnum

        plugin = ConsoleOutputPlugin()
        action = Action(type=ActionType.set_motion, motion=MotionEnum.wave, motion_duration=1.5)
        await plugin.emit(action)
        captured = capsys.readouterr()
        assert "动作" in captured.out
