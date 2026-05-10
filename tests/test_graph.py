
from bellis.core.enums import EventPriority
from bellis.core.events import CommandEvent, DanmakuEvent, GiftEvent
from bellis.core.state import AgentState
from bellis.graph.perception import (
    _analyze_emotion,
    _classify_intent,
    _reassess_priority,
    build_perception_graph,
    dequeue_event,
    perceive,
    route_after_perception,
)


class TestPerceptionHelpers:
    def test_classify_greeting(self):
        event = DanmakuEvent(content="你好呀")
        assert _classify_intent(event) == "greeting"

    def test_classify_question(self):
        event = DanmakuEvent(content="这个多少钱？")
        assert _classify_intent(event) == "question"

    def test_classify_gift(self):
        event = GiftEvent(content="送礼物", gift_name="火箭")
        assert _classify_intent(event) == "gift"

    def test_classify_command(self):
        event = CommandEvent(content="切换", command_type="switch_topic")
        assert _classify_intent(event) == "command"

    def test_classify_spam(self):
        event = DanmakuEvent(content="1")
        assert _classify_intent(event) == "spam"

    def test_analyze_emotion_positive(self):
        event = DanmakuEvent(content="太开心了哈哈")
        assert _analyze_emotion(event) == "happy"

    def test_analyze_emotion_gift(self):
        event = GiftEvent(content="送礼物")
        assert _analyze_emotion(event) == "happy"

    def test_reassess_priority_gift_high_value(self):
        event = GiftEvent(content="送火箭", coin_value=2000)
        assert _reassess_priority(event) == EventPriority.CRITICAL

    def test_reassess_priority_low_level_user(self):
        event = DanmakuEvent(content="你好", user_level=1, fan_badge=None)
        assert _reassess_priority(event) == EventPriority.LOW

    def test_reassess_priority_fan_badge(self):
        event = DanmakuEvent(content="你好", user_level=1, fan_badge="铁粉")
        assert _reassess_priority(event) == EventPriority.NORMAL


class TestPerceptionNodes:
    def test_dequeue_event(self):
        event = DanmakuEvent(content="test")
        state: AgentState = {
            "event_queue": [event],
            "current_event": None,
        }
        result = dequeue_event(state)
        assert result["current_event"] == event
        assert result["event_queue"] == []

    def test_dequeue_empty_queue(self):
        state: AgentState = {"event_queue": []}
        result = dequeue_event(state)
        assert result["current_event"] is None

    def test_perceive_with_event(self):
        event = GiftEvent(content="送火箭", coin_value=2000)
        state: AgentState = {
            "current_event": event,
            "metrics": {},
        }
        result = perceive(state)
        assert result["metrics"]["perception"]["intent"] == "gift"
        assert result["metrics"]["perception"]["reassessed_priority"] == "CRITICAL"

    def test_route_to_decision(self):
        event = GiftEvent(content="送礼物")
        state: AgentState = {
            "current_event": event,
            "metrics": {
                "perception": {
                    "reassessed_priority": "HIGH",
                    "intent": "gift",
                }
            },
        }
        assert route_after_perception(state) == "decision"

    def test_route_to_idle(self):
        state: AgentState = {
            "current_event": None,
            "metrics": {},
        }
        assert route_after_perception(state) == "idle"

    def test_route_to_interrupt(self):
        event = CommandEvent(content="中断", command_type="interrupt")
        state: AgentState = {
            "current_event": event,
            "interrupt_flag": True,
            "metrics": {},
        }
        assert route_after_perception(state) == "interrupt"


class TestPerceptionGraph:
    def test_build(self):
        graph = build_perception_graph()
        assert graph is not None
