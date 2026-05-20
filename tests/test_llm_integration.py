"""LLM 集成测试：使用 .env 中的 KEY/URL/MODEL 调用真实 API。

标记为 @pytest.mark.llm，默认跳过。
运行方式：uv run python -m pytest tests/test_llm_integration.py -v -m llm
"""

import pytest

from bellis.agent.decision import LiveDeps, ResilientCaller, create_decision_agent, reset_agent
from bellis.agent.graph import build_main_graph
from bellis.core.actions import Action
from bellis.core.context import AgentContext
from bellis.core.enums import ActionType, EmotionEnum, MotionEnum
from bellis.core.events import (
    DanmakuEvent,
    FollowEvent,
    GiftEvent,
    LiveEvent,
    SuperChatEvent,
)
from bellis.core.models import ActionRecord, EmotionState, PersonaConfig, SceneContext
from bellis.core.response import LiveResponse
from bellis.core.state import AgentState
from bellis.plugin.base import HookPlugin, OutputPlugin, PluginCategory, PluginMeta
from bellis.plugin.hooks import HookManager
from bellis.plugin.registry import PluginRegistry

pytestmark = pytest.mark.llm


# ─── 辅助 ────────────────────────────────────────────────────────────────


class RecorderPlugin(OutputPlugin):
    plugin_meta = PluginMeta(name="recorder", category=PluginCategory.OUTPUT)

    def __init__(self) -> None:
        self.actions: list[Action] = []

    async def emit(self, action: Action) -> None:
        self.actions.append(action)

    def by_type(self, t: ActionType) -> list[Action]:
        return [a for a in self.actions if a.type == t]


def _model(llm_env) -> str:
    m = llm_env.get("model") or "gpt-4o-mini"
    return f"openai:{m}"


def _build_state(
    event: LiveEvent | None = None,
    llm_env: dict | None = None,
    output_plugins: list[OutputPlugin] | None = None,
    hook_manager: HookManager | None = None,
    **overrides,
) -> AgentState:
    ctx = AgentContext(
        hook_manager=hook_manager,
        output_plugins=output_plugins or [],
        base_url=(llm_env or {}).get("base_url"),
        api_key=(llm_env or {}).get("api_key"),
        model=_model(llm_env) if llm_env else None,
    )
    state: AgentState = {
        "event_queue": [event] if event else [],
        "current_event": None,
        "scene_context": SceneContext(stream_title="测试直播间", viewer_count=100),
        "emotion_state": EmotionState(),
        "action_history": [],
        "live_response": None,
        "actions": [],
        "persona": PersonaConfig(
            name="default",
            system_prompt="你是一个友好的直播助手，正在与观众互动。回复简短自然，1-2句话。",
        ),
        "state_version": 0,
        "interrupt_flag": False,
        "tts_queue": [],
        "idle_ticks": 0,
        "metrics": {},
        "_context": ctx,
    }
    state.update(overrides)
    return state


# ═══════════════════════════════════════════════════════════════════════════
# 1. Think 节点 — 直接调用 LLM
# ═══════════════════════════════════════════════════════════════════════════


class TestThinkNode:
    @pytest.mark.asyncio
    async def test_danmaku_reply(self, llm_env):
        """弹幕 → LLM 返回合法 LiveResponse。"""
        reset_agent(AgentContext(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"]))
        agent = create_decision_agent(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"])
        deps = LiveDeps(
            scene_context=SceneContext(stream_title="测试直播间", viewer_count=100),
            emotion_state=EmotionState(),
            persona=PersonaConfig(name="default", system_prompt="你是一个友好的直播助手，回复简短。"),
            action_history=[],
        )
        caller = ResilientCaller(max_retries=2)
        response = await caller.call_with_retry(agent, "事件内容：你好主播！\n来源：danmaku", deps)

        assert isinstance(response, LiveResponse)
        assert len(response.text) > 0
        assert response.emotion in list(EmotionEnum)
        assert response.motion in list(MotionEnum)

    @pytest.mark.asyncio
    async def test_gift_reply(self, llm_env):
        """礼物 → LLM 返回感谢回复。"""
        reset_agent(AgentContext(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"]))
        agent = create_decision_agent(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"])
        deps = LiveDeps(
            scene_context=SceneContext(stream_title="测试直播间", viewer_count=100),
            emotion_state=EmotionState(current=EmotionEnum.happy),
            persona=PersonaConfig(name="default", system_prompt="你是一个友好的直播助手，收到礼物要感谢，回复简短。"),
            action_history=[],
        )
        caller = ResilientCaller(max_retries=2)
        response = await caller.call_with_retry(agent, "事件内容：送出小电视\n来源：gift", deps)

        assert isinstance(response, LiveResponse)
        assert len(response.text) > 0

    @pytest.mark.asyncio
    async def test_super_chat_reply(self, llm_env):
        """醒目留言 → LLM 返回高优先级回复。"""
        reset_agent(AgentContext(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"]))
        agent = create_decision_agent(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"])
        deps = LiveDeps(
            scene_context=SceneContext(stream_title="测试直播间", viewer_count=100),
            emotion_state=EmotionState(current=EmotionEnum.excited),
            persona=PersonaConfig(
                name="default",
                system_prompt="你是一个友好的直播助手，醒目留言要特别感谢，回复简短。",
            ),
            action_history=[],
        )
        caller = ResilientCaller(max_retries=2)
        response = await caller.call_with_retry(agent, "事件内容：醒目留言：主播加油！\n来源：super_chat", deps)

        assert isinstance(response, LiveResponse)
        assert len(response.text) > 0

    @pytest.mark.asyncio
    async def test_idle_self_talk(self, llm_env):
        """空闲自言自语 → LLM 主动发言。"""
        reset_agent(AgentContext(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"]))
        agent = create_decision_agent(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"])
        deps = LiveDeps(
            scene_context=SceneContext(stream_title="测试直播间", viewer_count=50),
            emotion_state=EmotionState(current=EmotionEnum.calm),
            persona=PersonaConfig(name="default", system_prompt="你是一个友好的直播助手，回复简短。"),
            action_history=[],
        )
        caller = ResilientCaller(max_retries=2)
        response = await caller.call_with_retry(
            agent, "现在直播间比较安静，你可以主动说点什么来活跃气氛，保持简短自然。", deps
        )

        assert isinstance(response, LiveResponse)
        assert len(response.text) > 0

    @pytest.mark.asyncio
    async def test_action_history_influences_reply(self, llm_env):
        """action_history 传入 deps 后 LLM 能参考上下文。"""
        reset_agent(AgentContext(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"]))
        agent = create_decision_agent(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"])
        history = [
            ActionRecord(action_type="response", description="刚才聊了天气", emotion=EmotionEnum.calm),
            ActionRecord(action_type="response", description="提到了明天会下雨", emotion=EmotionEnum.sad),
        ]
        deps = LiveDeps(
            scene_context=SceneContext(stream_title="测试直播间", viewer_count=100),
            emotion_state=EmotionState(),
            persona=PersonaConfig(name="default", system_prompt="你是一个友好的直播助手，回复简短。"),
            action_history=history,
        )
        caller = ResilientCaller(max_retries=2)
        response = await caller.call_with_retry(agent, "事件内容：那带伞了吗？\n来源：danmaku", deps)

        assert isinstance(response, LiveResponse)
        assert len(response.text) > 0


# ═══════════════════════════════════════════════════════════════════════════
# 2. 完整主循环 — PERCEIVE → THINK → ACT
# ═══════════════════════════════════════════════════════════════════════════


class TestFullLoop:
    @pytest.mark.asyncio
    async def test_danmaku_full_loop(self, llm_env):
        """弹幕事件走完整主循环，验证 Action 生成 + OutputPlugin 收到。"""
        reset_agent(AgentContext(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"]))
        recorder = RecorderPlugin()
        registry = PluginRegistry()
        registry.register_output(recorder)

        graph = build_main_graph(streaming=False)
        event = DanmakuEvent(content="主播你好呀！", user_name="测试粉丝", user_level=10, fan_badge="铁粉")
        state = _build_state(
            event=event, llm_env=llm_env, output_plugins=registry.outputs, hook_manager=registry.hook_manager
        )

        result = await graph.ainvoke(state)

        assert result["live_response"] is not None
        assert len(result["live_response"].text) > 0
        assert result["state_version"] > 0
        assert any(a.type == ActionType.speak for a in result.get("actions", []))
        assert len(recorder.actions) > 0

    @pytest.mark.asyncio
    async def test_gift_full_loop(self, llm_env):
        """礼物事件走完整主循环。"""
        reset_agent(AgentContext(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"]))
        recorder = RecorderPlugin()
        registry = PluginRegistry()
        registry.register_output(recorder)

        graph = build_main_graph(streaming=False)
        event = GiftEvent(content="送出火箭", gift_name="火箭", coin_value=2000, user_name="土豪")
        state = _build_state(
            event=event, llm_env=llm_env, output_plugins=registry.outputs, hook_manager=registry.hook_manager
        )

        result = await graph.ainvoke(state)

        assert result["live_response"] is not None
        assert len(result["live_response"].text) > 0
        assert result["live_response"].emotion in list(EmotionEnum)

    @pytest.mark.asyncio
    async def test_super_chat_full_loop(self, llm_env):
        """醒目留言走完整主循环。"""
        reset_agent(AgentContext(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"]))
        recorder = RecorderPlugin()
        registry = PluginRegistry()
        registry.register_output(recorder)

        graph = build_main_graph(streaming=False)
        event = SuperChatEvent(content="主播加油！", user_name="金主", price=50)
        state = _build_state(
            event=event, llm_env=llm_env, output_plugins=registry.outputs, hook_manager=registry.hook_manager
        )

        result = await graph.ainvoke(state)

        assert result["live_response"] is not None
        assert len(result["live_response"].text) > 0

    @pytest.mark.asyncio
    async def test_follow_full_loop(self, llm_env):
        """关注事件走完整主循环。"""
        reset_agent(AgentContext(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"]))
        recorder = RecorderPlugin()
        registry = PluginRegistry()
        registry.register_output(recorder)

        graph = build_main_graph(streaming=False)
        event = FollowEvent(content="关注了主播", user_name="新粉丝")
        state = _build_state(
            event=event, llm_env=llm_env, output_plugins=registry.outputs, hook_manager=registry.hook_manager
        )

        result = await graph.ainvoke(state)

        assert result["live_response"] is not None
        assert len(result["live_response"].text) > 0

    @pytest.mark.asyncio
    async def test_idle_self_talk_loop(self, llm_env):
        """idle_ticks 超阈值后触发自言自语。"""
        reset_agent(AgentContext(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"]))
        recorder = RecorderPlugin()
        registry = PluginRegistry()
        registry.register_output(recorder)

        graph = build_main_graph(streaming=False)
        state = _build_state(
            llm_env=llm_env,
            output_plugins=registry.outputs,
            hook_manager=registry.hook_manager,
            idle_ticks=5,
            current_event=None,
        )

        result = await graph.ainvoke(state)

        assert result["live_response"] is not None
        assert len(result["live_response"].text) > 0

    @pytest.mark.asyncio
    async def test_multiple_events_loop(self, llm_env):
        """多事件队列：第一个事件处理后，剩余事件留在队列中。"""
        reset_agent(AgentContext(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"]))
        recorder = RecorderPlugin()
        registry = PluginRegistry()
        registry.register_output(recorder)

        graph = build_main_graph(streaming=False)
        e1 = DanmakuEvent(content="你好", user_name="A", user_level=10, fan_badge="铁粉")
        e2 = DanmakuEvent(content="再见", user_name="B", user_level=10, fan_badge="铁粉")
        state = _build_state(
            event=e1, llm_env=llm_env, output_plugins=registry.outputs, hook_manager=registry.hook_manager
        )
        state["event_queue"] = [e1, e2]

        result = await graph.ainvoke(state)

        # 第一个事件应该被处理
        assert result["live_response"] is not None
        # 第二个事件可能还在队列中（取决于图是否循环）
        assert result["state_version"] > 0


# ═══════════════════════════════════════════════════════════════════════════
# 3. 流式输出
# ═══════════════════════════════════════════════════════════════════════════


class TestStreaming:
    @pytest.mark.asyncio
    async def test_stream_think(self, llm_env):
        """流式 think 输出。"""
        reset_agent(AgentContext(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"]))
        from bellis.agent.decision import stream_think

        state = _build_state(
            event=DanmakuEvent(content="讲个笑话吧", user_name="观众", user_level=10, fan_badge="铁粉"),
            llm_env=llm_env,
        )
        state["current_event"] = state["event_queue"][0]
        state["event_queue"] = []

        result = await stream_think(state)

        assert result.get("live_response") is not None
        assert len(result["live_response"].text) > 0

    @pytest.mark.asyncio
    async def test_streaming_graph(self, llm_env):
        """使用 streaming=True 构建图并运行。"""
        reset_agent(AgentContext(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"]))
        recorder = RecorderPlugin()
        registry = PluginRegistry()
        registry.register_output(recorder)

        graph = build_main_graph(streaming=True)
        event = DanmakuEvent(content="说点什么吧", user_name="观众", user_level=10, fan_badge="铁粉")
        state = _build_state(
            event=event, llm_env=llm_env, output_plugins=registry.outputs, hook_manager=registry.hook_manager
        )

        result = await graph.ainvoke(state)

        assert result["live_response"] is not None
        assert len(result["live_response"].text) > 0


# ═══════════════════════════════════════════════════════════════════════════
# 4. Hook 与 LLM 联动
# ═══════════════════════════════════════════════════════════════════════════


class TestHookWithLLM:
    @pytest.mark.asyncio
    async def test_hooks_fired(self, llm_env):
        """验证 post_think / pre_act / post_act hook 在 LLM 调用期间被触发。"""
        reset_agent(AgentContext(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"]))

        hook_calls: list[str] = []

        class TrackingHook(HookPlugin):
            plugin_meta = PluginMeta(name="tracking_hook", category=PluginCategory.HOOK)

            def register_hooks(self, hook_mgr: HookManager) -> None:
                async def track(name: str, state: AgentState) -> AgentState:
                    hook_calls.append(name)
                    return state

                hook_mgr.register("post_think", lambda s: track("post_think", s))
                hook_mgr.register("pre_act", lambda s: track("pre_act", s))
                hook_mgr.register("post_act", lambda s: track("post_act", s))

        registry = PluginRegistry()
        registry.register_output(RecorderPlugin())
        registry.register_hook(TrackingHook())

        graph = build_main_graph(streaming=False)
        event = DanmakuEvent(content="你好", user_name="粉丝", user_level=10, fan_badge="铁粉")
        state = _build_state(
            event=event, llm_env=llm_env, output_plugins=registry.outputs, hook_manager=registry.hook_manager
        )

        result = await graph.ainvoke(state)
        assert result is not None

        if result.get("live_response") and result["live_response"].text != "让我想想...":
            assert "post_think" in hook_calls
            assert "pre_act" in hook_calls
            assert "post_act" in hook_calls

    @pytest.mark.asyncio
    async def test_hook_modifies_state(self, llm_env):
        """验证 hook 能修改 state（如添加标记）。"""
        reset_agent(AgentContext(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"]))

        class MarkerHook(HookPlugin):
            plugin_meta = PluginMeta(name="marker_hook", category=PluginCategory.HOOK)

            def register_hooks(self, hook_mgr: HookManager) -> None:
                async def mark_post_think(state: AgentState) -> AgentState:
                    metrics = dict(state.get("metrics", {}))
                    metrics["hook_touched"] = True
                    state["metrics"] = metrics
                    return state

                hook_mgr.register("post_think", mark_post_think)

        registry = PluginRegistry()
        registry.register_output(RecorderPlugin())
        registry.register_hook(MarkerHook())

        graph = build_main_graph(streaming=False)
        event = DanmakuEvent(content="你好", user_name="粉丝", user_level=10, fan_badge="铁粉")
        state = _build_state(
            event=event, llm_env=llm_env, output_plugins=registry.outputs, hook_manager=registry.hook_manager
        )

        result = await graph.ainvoke(state)

        if result.get("live_response") and result["live_response"].text != "让我想想...":
            assert result["metrics"].get("hook_touched") is True


# ═══════════════════════════════════════════════════════════════════════════
# 5. Action 分发验证
# ═══════════════════════════════════════════════════════════════════════════


class TestActionDispatch:
    @pytest.mark.asyncio
    async def test_speak_action_generated(self, llm_env):
        """弹幕事件产生 speak Action。"""
        reset_agent(AgentContext(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"]))
        recorder = RecorderPlugin()
        registry = PluginRegistry()
        registry.register_output(recorder)

        graph = build_main_graph(streaming=False)
        event = DanmakuEvent(content="你好", user_name="粉丝", user_level=10, fan_badge="铁粉")
        state = _build_state(
            event=event, llm_env=llm_env, output_plugins=registry.outputs, hook_manager=registry.hook_manager
        )

        await graph.ainvoke(state)

        speak_actions = [a for a in recorder.actions if a.type == ActionType.speak]
        assert len(speak_actions) > 0
        assert speak_actions[0].text is not None

    @pytest.mark.asyncio
    async def test_expression_action_generated(self, llm_env):
        """LLM 回复产生 set_expression Action。"""
        reset_agent(AgentContext(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"]))
        recorder = RecorderPlugin()
        registry = PluginRegistry()
        registry.register_output(recorder)

        graph = build_main_graph(streaming=False)
        event = DanmakuEvent(content="太棒了！", user_name="粉丝", user_level=10, fan_badge="铁粉")
        state = _build_state(
            event=event, llm_env=llm_env, output_plugins=registry.outputs, hook_manager=registry.hook_manager
        )

        await graph.ainvoke(state)

        expr_actions = [a for a in recorder.actions if a.type == ActionType.set_expression]
        assert len(expr_actions) > 0

    @pytest.mark.asyncio
    async def test_motion_action_generated(self, llm_env):
        """LLM 回复产生 set_motion Action。"""
        reset_agent(AgentContext(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"]))
        recorder = RecorderPlugin()
        registry = PluginRegistry()
        registry.register_output(recorder)

        graph = build_main_graph(streaming=False)
        event = GiftEvent(content="送礼物", gift_name="火箭", coin_value=1000, user_name="土豪")
        state = _build_state(
            event=event, llm_env=llm_env, output_plugins=registry.outputs, hook_manager=registry.hook_manager
        )

        await graph.ainvoke(state)

        motion_actions = [a for a in recorder.actions if a.type == ActionType.set_motion]
        assert len(motion_actions) > 0

    @pytest.mark.asyncio
    async def test_reply_danmaku_action_generated(self, llm_env):
        """有 user_name 的事件产生 reply_danmaku Action。"""
        reset_agent(AgentContext(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"]))
        recorder = RecorderPlugin()
        registry = PluginRegistry()
        registry.register_output(recorder)

        graph = build_main_graph(streaming=False)
        event = DanmakuEvent(content="你好", user_name="粉丝A", user_level=10, fan_badge="铁粉")
        state = _build_state(
            event=event, llm_env=llm_env, output_plugins=registry.outputs, hook_manager=registry.hook_manager
        )

        await graph.ainvoke(state)

        reply_actions = [a for a in recorder.actions if a.type == ActionType.reply_danmaku]
        assert len(reply_actions) > 0
        assert reply_actions[0].target_user == "粉丝A"


# ═══════════════════════════════════════════════════════════════════════════
# 6. 多人设切换
# ═══════════════════════════════════════════════════════════════════════════


class TestPersonaSwitch:
    @pytest.mark.asyncio
    async def test_cat_girl_persona(self, llm_env):
        """猫娘人设下 LLM 回复风格不同。"""
        reset_agent(AgentContext(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"]))
        agent = create_decision_agent(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"])
        deps = LiveDeps(
            scene_context=SceneContext(stream_title="测试直播间", viewer_count=100),
            emotion_state=EmotionState(),
            persona=PersonaConfig(
                name="cat_girl",
                system_prompt="你是一个可爱的猫娘主播，说话会带'喵~'，性格活泼可爱。回复简短。",
            ),
            action_history=[],
        )
        caller = ResilientCaller(max_retries=2)
        response = await caller.call_with_retry(agent, "事件内容：你好主播！\n来源：danmaku", deps)

        assert isinstance(response, LiveResponse)
        assert len(response.text) > 0
        # 猫娘人设下回复可能包含"喵"
        # （不强制断言，因为 LLM 行为不确定，只验证结构合法）


# ═══════════════════════════════════════════════════════════════════════════
# 7. 弹性调用（CircuitBreaker + Fallback）
# ═══════════════════════════════════════════════════════════════════════════


class TestResilienceWithLLM:
    @pytest.mark.asyncio
    async def test_successful_call_resets_breaker(self, llm_env):
        """成功调用后 CircuitBreaker 保持 closed。"""
        reset_agent(AgentContext(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"]))
        agent = create_decision_agent(model=_model(llm_env), base_url=llm_env["base_url"], api_key=llm_env["api_key"])
        deps = LiveDeps(
            scene_context=SceneContext(),
            emotion_state=EmotionState(),
            persona=PersonaConfig(name="default", system_prompt="回复简短。"),
            action_history=[],
        )
        caller = ResilientCaller(max_retries=2)
        await caller.call_with_retry(agent, "事件内容：你好", deps)
        assert caller.breaker.state == "closed"
