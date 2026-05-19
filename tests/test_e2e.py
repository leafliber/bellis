import pytest

from bellis.config import ConfigCenter
from bellis.core.enums import ActionType
from bellis.core.events import CommandEvent, DanmakuEvent, GiftEvent
from bellis.core.models import EmotionState, PersonaConfig, SceneContext
from bellis.core.response import LiveResponse
from bellis.core.state import AgentState
from bellis.graph.execution import _response_to_actions, route_after_act
from bellis.graph.perception import dequeue_event, perceive, route_after_perception


class TestEndToEndPerception:
    @pytest.mark.asyncio
    async def test_danmaku_flow(self):
        event = DanmakuEvent(content="你好主播！", user_name="粉丝A", user_level=10, fan_badge="铁粉")
        state: AgentState = {
            "event_queue": [event],
            "current_event": None,
            "scene_context": SceneContext(),
            "emotion_state": EmotionState(),
            "action_history": [],
            "persona": PersonaConfig(),
            "state_version": 0,
            "interrupt_flag": False,
            "tts_queue": [],
            "idle_ticks": 0,
            "metrics": {},
        }
        result = dequeue_event(state)
        state.update(result)
        assert state["current_event"] == event

        result = await perceive(state)
        state.update(result)
        assert state["metrics"]["perception"]["intent"] == "greeting"
        assert state["metrics"]["perception"]["reassessed_priority"] == "NORMAL"

        route = route_after_perception(state)
        assert route == "think"

    @pytest.mark.asyncio
    async def test_gift_flow(self):
        event = GiftEvent(content="送火箭", gift_name="火箭", coin_value=2000, user_name="土豪")
        state: AgentState = {
            "event_queue": [event],
            "current_event": None,
            "scene_context": SceneContext(),
            "emotion_state": EmotionState(),
            "action_history": [],
            "persona": PersonaConfig(),
            "state_version": 0,
            "interrupt_flag": False,
            "tts_queue": [],
            "idle_ticks": 0,
            "metrics": {},
        }
        result = dequeue_event(state)
        state.update(result)
        result = await perceive(state)
        state.update(result)
        assert state["metrics"]["perception"]["intent"] == "gift"
        assert state["metrics"]["perception"]["reassessed_priority"] == "CRITICAL"
        route = route_after_perception(state)
        assert route == "think"

    @pytest.mark.asyncio
    async def test_interrupt_flow(self):
        event = CommandEvent(content="中断", command_type="interrupt")
        state: AgentState = {
            "event_queue": [event],
            "current_event": None,
            "scene_context": SceneContext(),
            "emotion_state": EmotionState(),
            "action_history": [],
            "persona": PersonaConfig(),
            "state_version": 0,
            "interrupt_flag": True,
            "tts_queue": [],
            "idle_ticks": 0,
            "metrics": {},
        }
        result = dequeue_event(state)
        state.update(result)
        result = await perceive(state)
        state.update(result)
        route = route_after_perception(state)
        assert route == "interrupt"

    @pytest.mark.asyncio
    async def test_spam_routed_to_end(self):
        event = DanmakuEvent(content="1", user_level=1, fan_badge=None)
        state: AgentState = {
            "event_queue": [event],
            "current_event": None,
            "scene_context": SceneContext(),
            "emotion_state": EmotionState(),
            "action_history": [],
            "persona": PersonaConfig(),
            "state_version": 0,
            "interrupt_flag": False,
            "tts_queue": [],
            "idle_ticks": 0,
            "metrics": {},
        }
        result = dequeue_event(state)
        state.update(result)
        result = await perceive(state)
        state.update(result)
        assert state["metrics"]["perception"]["intent"] == "spam"
        route = route_after_perception(state)
        assert route == "end"


class TestActionConversion:
    def test_response_to_actions(self):
        from bellis.core.enums import EmotionEnum, MotionEnum

        response = LiveResponse(
            text="谢谢！",
            emotion=EmotionEnum.happy,
            motion=MotionEnum.wave,
            target_user="粉丝A",
        )
        event = DanmakuEvent(content="送礼物", user_name="粉丝A")
        state: AgentState = {
            "live_response": response,
            "current_event": event,
        }
        actions = _response_to_actions(state)
        assert len(actions) >= 3  # speak + set_expression + set_motion + reply_danmaku
        assert any(a.type == ActionType.speak for a in actions)
        assert any(a.type == ActionType.set_expression for a in actions)
        assert any(a.type == ActionType.set_motion for a in actions)
        assert any(a.type == ActionType.reply_danmaku for a in actions)

    def test_route_after_act_with_more_events(self):
        state: AgentState = {
            "event_queue": [DanmakuEvent(content="next")],
        }
        assert route_after_act(state) == "perceive"

    def test_route_after_act_empty_queue(self):
        state: AgentState = {
            "event_queue": [],
        }
        assert route_after_act(state) == "end"


class TestConfigCenter:
    def test_default_personas(self):
        config = ConfigCenter()
        assert "default" in config.personas
        assert "cat_girl" in config.personas
        assert config.active_persona == "default"

    def test_switch_persona(self):
        config = ConfigCenter()
        config.switch_persona("cat_girl")
        assert config.active_persona == "cat_girl"
        persona = config.get_active_persona()
        assert "猫娘" in persona.system_prompt

    def test_switch_invalid_persona(self):
        config = ConfigCenter()
        with pytest.raises(KeyError):
            config.switch_persona("nonexistent")

    def test_register_persona(self):
        config = ConfigCenter()
        new_persona = PersonaConfig(
            name="cool_guy",
            system_prompt="你是一个酷酷的主播。",
        )
        config.register_persona(new_persona)
        assert "cool_guy" in config.personas

    def test_to_dict_and_from_dict(self):
        config = ConfigCenter()
        data = config.to_dict()
        restored = ConfigCenter.from_dict(data)
        assert restored.active_persona == config.active_persona
        assert set(restored.personas.keys()) == set(config.personas.keys())
