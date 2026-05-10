import pytest

from bellis.core.enums import EmotionEnum, EventPriority, EventSource, MotionEnum
from bellis.core.events import CommandEvent, DanmakuEvent, GiftEvent, LiveEvent, RAGEvent
from bellis.core.models import EmotionState, PersonaConfig
from bellis.core.response import LiveResponse


class TestLiveEvent:
    def test_base_event_defaults(self):
        event = LiveEvent(content="hello")
        assert event.content == "hello"
        assert event.priority == EventPriority.NORMAL
        assert event.source == EventSource.SYSTEM
        assert event.metadata == {}

    def test_danmaku_event_defaults(self):
        event = DanmakuEvent(content="你好", user_name="test_user")
        assert event.source == EventSource.DANMAKU
        assert event.priority == EventPriority.NORMAL
        assert event.user_name == "test_user"
        assert event.fan_badge is None

    def test_gift_event_high_priority(self):
        event = GiftEvent(content="送礼物", gift_name="火箭", coin_value=500)
        assert event.source == EventSource.GIFT
        assert event.priority == EventPriority.HIGH
        assert event.coin_value == 500

    def test_command_event_critical_priority(self):
        event = CommandEvent(content="切换话题", command_type="switch_topic")
        assert event.source == EventSource.COMMAND
        assert event.priority == EventPriority.CRITICAL

    def test_rag_event(self):
        event = RAGEvent(content="查询结果", query="价格", retrieved_docs=["doc1"])
        assert event.source == EventSource.RAG
        assert event.retrieved_docs == ["doc1"]

    def test_frozen_event(self):
        event = LiveEvent(content="hello")
        with pytest.raises(Exception):
            event.content = "changed"


class TestLiveResponse:
    def test_defaults(self):
        resp = LiveResponse(text="你好")
        assert resp.emotion == EmotionEnum.neutral
        assert resp.motion == MotionEnum.idle
        assert resp.tts_speed == 1.0
        assert resp.target_user is None
        assert resp.motion_duration == 1.0
        assert resp.wait_for_next is False

    def test_with_all_fields(self):
        resp = LiveResponse(
            text="谢谢！",
            emotion=EmotionEnum.happy,
            motion=MotionEnum.wave,
            tts_speed=1.2,
            priority=1,
            target_user="粉丝A",
            motion_duration=2.0,
            wait_for_next=True,
        )
        assert resp.emotion == EmotionEnum.happy
        assert resp.target_user == "粉丝A"
        assert resp.motion_duration == 2.0

    def test_tts_speed_validation(self):
        with pytest.raises(Exception):
            LiveResponse(text="test", tts_speed=0.5)
        with pytest.raises(Exception):
            LiveResponse(text="test", tts_speed=2.0)


class TestEmotionState:
    def test_defaults(self):
        state = EmotionState()
        assert state.current == EmotionEnum.neutral
        assert state.intensity == 0.5


class TestPersonaConfig:
    def test_defaults(self):
        config = PersonaConfig()
        assert config.name == "default"
        assert config.tts_speed_range == (0.8, 1.5)
