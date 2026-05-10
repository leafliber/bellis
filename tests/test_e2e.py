import pytest

from bellis.config import ConfigCenter
from bellis.core.events import CommandEvent, DanmakuEvent, GiftEvent
from bellis.core.models import EmotionState, PersonaConfig, SceneContext
from bellis.core.state import AgentState
from bellis.graph.perception import dequeue_event, perceive, route_after_perception, throttle


class TestEndToEndPerception:
    def test_danmaku_flow(self):
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
            "metrics": {},
        }
        result = dequeue_event(state)
        state.update(result)
        assert state["current_event"] == event

        result = perceive(state)
        state.update(result)
        assert state["metrics"]["perception"]["intent"] == "greeting"
        assert state["metrics"]["perception"]["reassessed_priority"] == "NORMAL"

        route = route_after_perception(state)
        assert route == "decision"

    def test_gift_flow(self):
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
            "metrics": {},
        }
        result = dequeue_event(state)
        state.update(result)
        result = perceive(state)
        state.update(result)
        assert state["metrics"]["perception"]["intent"] == "gift"
        assert state["metrics"]["perception"]["reassessed_priority"] == "CRITICAL"
        route = route_after_perception(state)
        assert route == "decision"

    def test_interrupt_flow(self):
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
            "metrics": {},
        }
        result = dequeue_event(state)
        state.update(result)
        result = perceive(state)
        state.update(result)
        route = route_after_perception(state)
        assert route == "interrupt"

    def test_spam_throttled(self):
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
            "metrics": {},
        }
        result = dequeue_event(state)
        state.update(result)
        result = perceive(state)
        state.update(result)
        assert state["metrics"]["perception"]["intent"] == "spam"
        route = route_after_perception(state)
        assert route == "throttle"

        result = throttle(state)
        state.update(result)
        assert len(state["metrics"]["throttled"]) == 1


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
