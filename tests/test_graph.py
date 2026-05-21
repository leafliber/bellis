"""Agent 图节点的单元测试。

覆盖感知辅助函数（意图分类、情绪分析、优先级重评估）、
感知节点、执行节点、中断处理、路由决策、响应转动作等核心逻辑。
"""

import pytest

from bellis.agent.execution import _response_to_actions, act, handle_interrupt, route_after_act
from bellis.agent.graph import build_main_graph
from bellis.agent.perception import (
    _analyze_emotion,
    _classify_intent,
    _reassess_priority,
    dequeue_event,
    perceive,
    route_after_perception,
)
from bellis.core.actions import Action
from bellis.core.context import AgentContext
from bellis.core.enums import ActionType, EmotionEnum, EventPriority, MotionEnum
from bellis.core.events import CommandEvent, DanmakuEvent, EnterEvent, FollowEvent, GiftEvent, IdleEvent, SuperChatEvent
from bellis.core.models import EmotionState
from bellis.core.response import LiveResponse
from bellis.core.state import AgentState
from unittest.mock import AsyncMock, patch

_IDLE_THRESHOLD = 5  # 空闲自言自语触发阈值，与 Agent 配置保持一致


class TestPerceptionHelpers:
    """感知辅助函数测试：意图分类、情绪分析、优先级重评估。"""
    def test_classify_greeting(self):
        event = DanmakuEvent(content="你好呀")
        assert _classify_intent(event) == "greeting"

    def test_classify_question(self):
        event = DanmakuEvent(content="这个多少钱？")
        assert _classify_intent(event) == "question"

    def test_classify_gift(self):
        event = GiftEvent(content="送礼物", gift_name="火箭")
        assert _classify_intent(event) == "gift"

    def test_classify_super_chat(self):
        event = SuperChatEvent(content="醒目留言", price=50)
        assert _classify_intent(event) == "gift"

    def test_classify_command(self):
        event = CommandEvent(content="切换", command_type="switch_topic")
        assert _classify_intent(event) == "command"

    def test_classify_spam(self):
        event = DanmakuEvent(content="1")
        assert _classify_intent(event) == "spam"

    def test_classify_follow(self):
        event = FollowEvent(content="关注了", user_name="粉丝")
        assert _classify_intent(event) == "greeting"

    def test_classify_enter(self):
        event = EnterEvent(content="进入直播间", user_name="新人")
        assert _classify_intent(event) == "greeting"

    def test_classify_chat(self):
        event = DanmakuEvent(content="今天天气不错")
        assert _classify_intent(event) == "chat"

    def test_analyze_emotion_positive(self):
        event = DanmakuEvent(content="太开心了哈哈")
        assert _analyze_emotion(event) == "happy"

    def test_analyze_emotion_negative(self):
        event = DanmakuEvent(content="太讨厌了")
        assert _analyze_emotion(event) == "angry"

    def test_analyze_emotion_gift(self):
        event = GiftEvent(content="送礼物")
        assert _analyze_emotion(event) == "excited"

    def test_analyze_emotion_super_chat(self):
        event = SuperChatEvent(content="醒目留言", price=50)
        assert _analyze_emotion(event) == "excited"

    def test_analyze_emotion_follow(self):
        event = FollowEvent(content="关注了", user_name="粉丝")
        assert _analyze_emotion(event) == "happy"

    def test_reassess_priority_gift_high_value(self):
        event = GiftEvent(content="送火箭", coin_value=2000)
        assert _reassess_priority(event) == EventPriority.CRITICAL

    def test_reassess_priority_gift_normal(self):
        event = GiftEvent(content="送小花", coin_value=100)
        assert _reassess_priority(event) == EventPriority.HIGH

    def test_reassess_priority_super_chat(self):
        event = SuperChatEvent(content="醒目留言", price=50)
        assert _reassess_priority(event) == EventPriority.CRITICAL

    def test_reassess_priority_follow(self):
        event = FollowEvent(content="关注了", user_name="粉丝")
        assert _reassess_priority(event) == EventPriority.HIGH

    def test_reassess_priority_low_level_user(self):
        event = DanmakuEvent(content="你好", user_level=1, fan_badge=None)
        assert _reassess_priority(event) == EventPriority.LOW

    def test_reassess_priority_fan_badge(self):
        event = DanmakuEvent(content="你好", user_level=1, fan_badge="铁粉")
        assert _reassess_priority(event) == EventPriority.NORMAL

    def test_reassess_priority_enter(self):
        event = EnterEvent(content="进入直播间", user_name="新人")
        assert _reassess_priority(event) == EventPriority.LOW


class TestPerceptionNodes:
    """感知节点测试：事件出队、感知处理、路由决策。"""
    def test_dequeue_event(self):
        event = DanmakuEvent(content="test")
        state: AgentState = {"event_queue": [event], "current_event": None}
        result = dequeue_event(state)
        assert result["current_event"] == event
        assert result["event_queue"] == []

    def test_dequeue_empty_queue(self):
        state: AgentState = {"event_queue": []}
        result = dequeue_event(state)
        assert result["current_event"] is None

    @pytest.mark.asyncio
    async def test_perceive_with_event(self):
        event = GiftEvent(content="送火箭", coin_value=2000)
        state: AgentState = {"current_event": event, "metrics": {}, "_context": AgentContext()}
        result = await perceive(state)
        assert result["metrics"]["perception"]["intent"] == "gift"
        assert result["metrics"]["perception"]["reassessed_priority"] == "CRITICAL"
        assert result["idle_ticks"] == 0

    @pytest.mark.asyncio
    async def test_perceive_no_event_increments_idle(self):
        state: AgentState = {"current_event": None, "idle_ticks": 3, "metrics": {}, "_context": AgentContext()}
        result = await perceive(state)
        assert result["idle_ticks"] == 4

    @pytest.mark.asyncio
    async def test_perceive_idle_event_resets_idle(self):
        """IdleEvent 作为普通事件处理，重置 idle_ticks 为 0 并记录感知信息。"""
        event = IdleEvent(content="idle_tick")
        state: AgentState = {"current_event": event, "idle_ticks": 2, "metrics": {}, "_context": AgentContext()}
        result = await perceive(state)
        assert result["idle_ticks"] == 0
        assert "perception" in result.get("metrics", {})

    @pytest.mark.asyncio
    async def test_perceive_normal_event_resets_idle(self):
        """普通事件应重置 idle_ticks 为 0。"""
        event = DanmakuEvent(content="你好", user_level=10, fan_badge="铁粉")
        state: AgentState = {"current_event": event, "idle_ticks": 5, "metrics": {}, "_context": AgentContext()}
        result = await perceive(state)
        assert result["idle_ticks"] == 0

    def test_route_to_think(self):
        event = GiftEvent(content="送礼物")
        state: AgentState = {
            "current_event": event,
            "metrics": {"perception": {"reassessed_priority": "HIGH", "intent": "gift"}},
        }
        assert route_after_perception(state) == "think"

    def test_route_normal_to_think(self):
        event = DanmakuEvent(content="你好", user_level=10, fan_badge="铁粉")
        state: AgentState = {
            "current_event": event,
            "metrics": {"perception": {"reassessed_priority": "NORMAL", "intent": "greeting"}},
        }
        assert route_after_perception(state) == "think"

    def test_route_to_end_when_idle(self):
        state: AgentState = {"current_event": None, "idle_ticks": 1, "metrics": {}}
        assert route_after_perception(state) == "end"

    def test_route_to_think_when_idle_threshold(self):
        state: AgentState = {
            "current_event": None,
            "idle_ticks": _IDLE_THRESHOLD,
            "metrics": {},
            "_context": AgentContext(),
        }
        assert route_after_perception(state) == "think"

    def test_route_to_interrupt(self):
        event = CommandEvent(content="中断", command_type="interrupt")
        state: AgentState = {"current_event": event, "interrupt_flag": True, "metrics": {}}
        assert route_after_perception(state) == "interrupt"

    def test_route_spam_to_end(self):
        event = DanmakuEvent(content="1", user_level=1, fan_badge=None)
        state: AgentState = {
            "current_event": event,
            "metrics": {"perception": {"reassessed_priority": "LOW", "intent": "spam"}},
        }
        assert route_after_perception(state) == "end"

    def test_route_low_priority_to_end(self):
        event = DanmakuEvent(content="你好", user_level=1, fan_badge=None)
        state: AgentState = {
            "current_event": event,
            "metrics": {"perception": {"reassessed_priority": "LOW", "intent": "chat"}},
        }
        assert route_after_perception(state) == "end"

    def test_route_idle_event_below_threshold_to_end(self):
        """IdleEvent 且 idle_ticks 未达阈值时路由到 end。"""
        event = IdleEvent(content="idle_tick")
        state: AgentState = {
            "current_event": event,
            "idle_ticks": 1,
            "metrics": {"perception": {"reassessed_priority": "LOW", "intent": "idle"}},
            "_context": AgentContext(),
        }
        assert route_after_perception(state) == "end"

    def test_route_idle_event_at_threshold_to_think(self):
        """IdleEvent 且 idle_ticks 达到阈值时路由到 think。"""
        event = IdleEvent(content="idle_tick")
        state: AgentState = {
            "current_event": event,
            "idle_ticks": _IDLE_THRESHOLD,
            "metrics": {"perception": {"reassessed_priority": "LOW", "intent": "idle"}},
            "_context": AgentContext(),
        }
        assert route_after_perception(state) == "think"


class TestActNode:
    """执行节点测试：Action 生成、OutputPlugin 分发、Hook 触发。"""
    @pytest.mark.asyncio
    async def test_act_generates_actions(self):
        """act 节点应将 LiveResponse 转换为 Action 列表。"""
        response = LiveResponse(text="你好！", emotion=EmotionEnum.happy, motion=MotionEnum.wave, target_user="粉丝")
        event = DanmakuEvent(content="你好", user_name="粉丝")
        state: AgentState = {
            "live_response": response,
            "current_event": event,
            "_context": AgentContext(),
        }
        result = await act(state)
        assert len(result.get("actions", [])) > 0
        assert any(a.type == ActionType.speak for a in result["actions"])
        assert result["state_version"] > 0

    @pytest.mark.asyncio
    async def test_act_no_response(self):
        """无 LiveResponse 时 act 不产生 Action。"""
        state: AgentState = {
            "live_response": None,
            "_context": AgentContext(),
        }
        result = await act(state)
        assert result == {}

    @pytest.mark.asyncio
    async def test_act_dispatches_to_output_plugins(self):
        """act 应将 Action 分发给 OutputPlugin。"""
        from bellis.plugin.base import OutputPlugin, PluginCategory, PluginMeta

        class Collector(OutputPlugin):
            plugin_meta = PluginMeta(name="collector", category=PluginCategory.OUTPUT)

            def __init__(self):
                self.actions = []

            async def emit(self, action: Action):
                self.actions.append(action)

        collector = Collector()
        response = LiveResponse(text="测试", emotion=EmotionEnum.neutral)
        event = DanmakuEvent(content="你好", user_name="粉丝")
        state: AgentState = {
            "live_response": response,
            "current_event": event,
            "_context": AgentContext(output_plugins=[collector]),
        }
        await act(state)
        assert len(collector.actions) > 0

    @pytest.mark.asyncio
    async def test_act_with_hooks(self):
        """act 节点应触发 pre_act 和 post_act hooks。"""
        from bellis.plugin.hooks import HookManager

        hook_mgr = HookManager()
        calls = []

        async def pre_act_hook(state):
            calls.append("pre_act")
            return state

        async def post_act_hook(state):
            calls.append("post_act")
            return state

        hook_mgr.register("pre_act", pre_act_hook)
        hook_mgr.register("post_act", post_act_hook)

        response = LiveResponse(text="测试", emotion=EmotionEnum.neutral)
        state: AgentState = {
            "live_response": response,
            "current_event": DanmakuEvent(content="你好"),
            "_context": AgentContext(hook_manager=hook_mgr),
        }
        await act(state)
        assert "pre_act" in calls
        assert "post_act" in calls


class TestHandleInterrupt:
    """中断处理测试：人设切换、话题切换、非命令事件。"""
    @pytest.mark.asyncio
    async def test_switch_persona(self):
        event = CommandEvent(content="切换人设", command_type="switch_persona", payload={"name": "cat_girl"})
        state: AgentState = {"current_event": event, "interrupt_flag": True, "metrics": {}}
        result = await handle_interrupt(state)
        assert result["interrupt_flag"] is False
        assert "switch_persona:cat_girl" in result["metrics"]["interrupt_action"]

    @pytest.mark.asyncio
    async def test_switch_topic(self):
        event = CommandEvent(content="切换话题", command_type="switch_topic", payload={"topic": "游戏"})
        state: AgentState = {"current_event": event, "interrupt_flag": True, "metrics": {}}
        result = await handle_interrupt(state)
        assert "switch_topic:游戏" in result["metrics"]["interrupt_action"]

    @pytest.mark.asyncio
    async def test_non_command_event(self):
        event = DanmakuEvent(content="你好")
        state: AgentState = {"current_event": event, "interrupt_flag": True, "metrics": {}}
        result = await handle_interrupt(state)
        assert result == {}

    @pytest.mark.asyncio
    async def test_no_event(self):
        state: AgentState = {"current_event": None, "metrics": {}}
        result = await handle_interrupt(state)
        assert result == {}


class TestRouteAfterAct:
    """执行后路由测试：根据事件队列是否为空决定下一节点。"""
    def test_with_more_events(self):
        state: AgentState = {"event_queue": [DanmakuEvent(content="next")]}
        assert route_after_act(state) == "perceive"

    def test_empty_queue(self):
        state: AgentState = {"event_queue": []}
        assert route_after_act(state) == "end"


class TestResponseToActions:
    """LiveResponse 转 Action 列表测试。"""
    def test_full_response(self):
        response = LiveResponse(text="谢谢！", emotion=EmotionEnum.happy, motion=MotionEnum.wave, target_user="粉丝A")
        event = DanmakuEvent(content="送礼物", user_name="粉丝A")
        state: AgentState = {"live_response": response, "current_event": event}
        actions = _response_to_actions(state)
        assert len(actions) >= 3
        assert any(a.type == ActionType.speak for a in actions)
        assert any(a.type == ActionType.set_expression for a in actions)
        assert any(a.type == ActionType.set_motion for a in actions)
        assert any(a.type == ActionType.reply_danmaku for a in actions)

    def test_no_target_user(self):
        """无 user_name 的事件不产生 reply_danmaku。"""
        response = LiveResponse(text="大家好", emotion=EmotionEnum.happy, motion=MotionEnum.wave)
        event = DanmakuEvent(content="你好")
        state: AgentState = {"live_response": response, "current_event": event}
        actions = _response_to_actions(state)
        assert not any(a.type == ActionType.reply_danmaku for a in actions)

    def test_no_response(self):
        state: AgentState = {"live_response": None, "current_event": None}
        actions = _response_to_actions(state)
        assert actions == []

    def test_speak_action_has_text(self):
        response = LiveResponse(text="你好世界")
        event = DanmakuEvent(content="你好")
        state: AgentState = {"live_response": response, "current_event": event}
        actions = _response_to_actions(state)
        speak = [a for a in actions if a.type == ActionType.speak]
        assert len(speak) == 1
        assert speak[0].text == "你好世界"


class TestGraphCompilation:
    """图编译测试：验证 build_main_graph 能正常编译返回图对象。"""

    def test_build_main_graph_compiles(self):
        """build_main_graph() 应返回编译后的图对象。"""
        graph = build_main_graph()
        # 编译后的图对象应具有 invoke / ainvoke 方法
        assert hasattr(graph, "invoke")
        assert hasattr(graph, "ainvoke")

    def test_build_streaming_graph_compiles(self):
        """build_main_graph(streaming=True) 应返回编译后的图对象。"""
        graph = build_main_graph(streaming=True)
        assert hasattr(graph, "invoke")
        assert hasattr(graph, "ainvoke")


class TestGraphExecution:
    """图执行测试：验证图在端到端场景下的行为。"""

    @pytest.mark.asyncio
    async def test_graph_processes_single_danmaku(self):
        """测试图处理单条弹幕：mock think 节点，验证 live_response 被生成。"""
        mock_response = LiveResponse(text="你好！", emotion=EmotionEnum.happy, motion=MotionEnum.wave)
        mock_think = AsyncMock(return_value={
            "live_response": mock_response,
            "emotion_state": EmotionState(),
            "action_history": [],
            "state_version": 1,
            "idle_ticks": 0,
        })

        # 在 build_main_graph 内部延迟导入 decision.think 之前进行 patch
        with patch("bellis.agent.decision.think", mock_think):
            graph = build_main_graph()
            event = DanmakuEvent(content="你好", user_level=10, fan_badge="铁粉")
            initial_state: AgentState = {
                "event_queue": [event],
                "current_event": None,
                "idle_ticks": 0,
                "metrics": {},
                "_context": AgentContext(),
            }
            result = await graph.ainvoke(initial_state)
            # 图应成功执行并生成 live_response
            assert result.get("live_response") is not None

    @pytest.mark.asyncio
    async def test_graph_with_empty_queue_routes_to_end(self):
        """测试空事件队列且无空闲 tick 时，图应快速路由到 end，不生成 live_response。"""
        graph = build_main_graph()
        initial_state: AgentState = {
            "event_queue": [],
            "current_event": None,
            "idle_ticks": 0,
            "metrics": {},
            "_context": AgentContext(),
        }
        result = await graph.ainvoke(initial_state)
        # 空队列 + idle_ticks < 阈值 → dequeue → perceive → end，不应生成 live_response
        assert result.get("live_response") is None


class TestDequeueEventEdgeCases:
    """出队边界情况测试：验证多事件出队和单事件出队行为。"""

    def test_dequeue_preserves_remaining_events(self):
        """出队第一个事件后，剩余事件应保留在队列中。"""
        event1 = DanmakuEvent(content="第一条")
        event2 = DanmakuEvent(content="第二条")
        event3 = DanmakuEvent(content="第三条")
        state: AgentState = {"event_queue": [event1, event2, event3]}
        result = dequeue_event(state)
        # 第一个事件被出队
        assert result["current_event"] == event1
        # 剩余事件仍保留在队列中
        assert result["event_queue"] == [event2, event3]

    def test_dequeue_single_event(self):
        """单事件队列出队后应变为空。"""
        event = DanmakuEvent(content="唯一一条")
        state: AgentState = {"event_queue": [event]}
        result = dequeue_event(state)
        assert result["current_event"] == event
        assert result["event_queue"] == []
