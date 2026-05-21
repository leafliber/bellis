"""事件模型、响应模型、动作模型及配置模型的单元测试。

覆盖 LiveEvent 各子类的默认值与优先级、LiveResponse 字段验证、
Action 类型构造、EmotionState 边界值、PersonaConfig 默认配置等。
"""

import pytest
from datetime import datetime
from pydantic import ValidationError

from bellis.core.enums import ActionType, EmotionEnum, EventPriority, EventSource, MotionEnum
from bellis.core.events import (
    CommandEvent,
    DanmakuEvent,
    EnterEvent,
    FollowEvent,
    GiftEvent,
    IdleEvent,
    LiveEvent,
    RAGEvent,
    SuperChatEvent,
    VoiceEvent,
)
from bellis.core.models import EmotionState, PersonaConfig
from bellis.core.response import LiveResponse


class TestLiveEvent:
    """LiveEvent 及其子类的默认值和优先级测试。"""
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

    def test_super_chat_event(self):
        event = SuperChatEvent(content="醒目留言", user_name="土豪", price=50)
        assert event.source == EventSource.SUPER_CHAT
        assert event.priority == EventPriority.CRITICAL
        assert event.price == 50

    def test_enter_event(self):
        event = EnterEvent(content="进入直播间", user_name="新人")
        assert event.source == EventSource.ENTER
        assert event.priority == EventPriority.LOW

    def test_follow_event(self):
        event = FollowEvent(content="关注了主播", user_name="粉丝")
        assert event.source == EventSource.FOLLOW
        assert event.priority == EventPriority.HIGH

    def test_voice_event(self):
        event = VoiceEvent(content="语音消息", audio_data=b"fake_audio")
        assert event.source == EventSource.VOICE
        assert event.language == "zh"

    def test_idle_event(self):
        event = IdleEvent(content="idle_tick")
        assert event.source == EventSource.IDLE
        assert event.priority == EventPriority.LOW

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
        with pytest.raises(ValidationError):
            event.content = "changed"


class TestLiveResponse:
    """LiveResponse 字段默认值和验证测试。"""
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
        with pytest.raises(ValidationError):
            LiveResponse(text="test", tts_speed=0.5)
        with pytest.raises(ValidationError):
            LiveResponse(text="test", tts_speed=2.0)


class TestAction:
    """Action 各类型的构造测试。"""
    def test_speak_action(self):
        from bellis.core.actions import Action

        action = Action(type=ActionType.speak, text="你好", emotion=EmotionEnum.happy)
        assert action.type == ActionType.speak
        assert action.text == "你好"

    def test_set_expression_action(self):
        from bellis.core.actions import Action

        action = Action(type=ActionType.set_expression, expression="happy")
        assert action.type == ActionType.set_expression

    def test_set_motion_action(self):
        from bellis.core.actions import Action

        action = Action(type=ActionType.set_motion, motion=MotionEnum.wave, motion_duration=2.0)
        assert action.type == ActionType.set_motion
        assert action.motion_duration == 2.0

    def test_reply_danmaku_action(self):
        from bellis.core.actions import Action

        action = Action(type=ActionType.reply_danmaku, reply_text="谢谢", target_user="粉丝")
        assert action.type == ActionType.reply_danmaku
        assert action.target_user == "粉丝"

    def test_change_bg_action(self):
        from bellis.core.actions import Action

        action = Action(type=ActionType.change_bg, metadata={"bg": "night"})
        assert action.type == ActionType.change_bg

    def test_tool_call_action(self):
        from bellis.core.actions import Action

        action = Action(type=ActionType.tool_call, metadata={"tool": "search", "args": {"q": "天气"}})
        assert action.type == ActionType.tool_call

    def test_custom_action(self):
        from bellis.core.actions import Action

        action = Action(type=ActionType.custom, metadata={"key": "value"})
        assert action.type == ActionType.custom


class TestEmotionState:
    """EmotionState 默认值和边界值测试。"""
    def test_defaults(self):
        state = EmotionState()
        assert state.current == EmotionEnum.neutral
        assert state.intensity == 0.5

    def test_intensity_bounds(self):
        state = EmotionState(current=EmotionEnum.happy, intensity=1.0)
        assert state.intensity == 1.0
        state = EmotionState(current=EmotionEnum.sad, intensity=0.0)
        assert state.intensity == 0.0


class TestPersonaConfig:
    """PersonaConfig 默认配置和自定义配置测试。"""
    def test_defaults(self):
        config = PersonaConfig()
        assert config.name == "default"
        assert config.tts_speed_range == (0.8, 1.5)

    def test_custom_persona(self):
        config = PersonaConfig(
            name="cat_girl",
            system_prompt="你是一个猫娘",
            emotion_map={"开心": EmotionEnum.happy},
            motion_map={"打招呼": MotionEnum.wave},
        )
        assert config.name == "cat_girl"
        assert EmotionEnum.happy in config.emotion_map.values()


class TestLiveEventSubclassFields:
    """各子类独有字段的完整测试。"""

    def test_danmaku_event_all_fields(self):
        """测试弹幕事件所有字段。"""
        event = DanmakuEvent(
            content="你好",
            user_id="uid_001",
            user_name="test_user",
            user_level=5,
            fan_badge="铁粉",
        )
        assert event.user_id == "uid_001"
        assert event.user_name == "test_user"
        assert event.user_level == 5
        assert event.fan_badge == "铁粉"

    def test_gift_event_all_fields(self):
        """测试礼物事件所有字段。"""
        event = GiftEvent(
            content="送礼物",
            user_id="uid_002",
            user_name="土豪哥",
            gift_name="火箭",
            gift_count=3,
            coin_value=1500,
        )
        assert event.user_id == "uid_002"
        assert event.user_name == "土豪哥"
        assert event.gift_name == "火箭"
        assert event.gift_count == 3
        assert event.coin_value == 1500

    def test_super_chat_event_all_fields(self):
        """测试醒目留言事件所有字段。"""
        event = SuperChatEvent(
            content="醒目留言",
            user_id="uid_003",
            user_name="大老板",
            price=100,
            duration=60,
        )
        assert event.user_id == "uid_003"
        assert event.user_name == "大老板"
        assert event.price == 100
        assert event.duration == 60

    def test_command_event_payload(self):
        """测试命令事件的 command_type 和 payload 字段。"""
        event = CommandEvent(
            content="切换话题",
            command_type="switch_topic",
            payload={"topic": "天气"},
        )
        assert event.command_type == "switch_topic"
        assert event.payload == {"topic": "天气"}

    def test_rag_event_fields(self):
        """测试 RAG 事件的 query 和 retrieved_docs 字段。"""
        event = RAGEvent(
            content="查询结果",
            query="今日价格",
            retrieved_docs=["doc1", "doc2"],
        )
        assert event.query == "今日价格"
        assert event.retrieved_docs == ["doc1", "doc2"]

    def test_voice_event_fields(self):
        """测试语音事件的 audio_data 和 language 字段。"""
        event = VoiceEvent(
            content="语音消息",
            audio_data=b"\x00\x01\x02",
            language="en",
        )
        assert event.audio_data == b"\x00\x01\x02"
        assert event.language == "en"

    def test_enter_event_fields(self):
        """测试进场事件的 user_id 和 user_name 字段。"""
        event = EnterEvent(
            content="进入直播间",
            user_id="uid_004",
            user_name="新人小白",
        )
        assert event.user_id == "uid_004"
        assert event.user_name == "新人小白"

    def test_follow_event_fields(self):
        """测试关注事件的 user_id 和 user_name 字段。"""
        event = FollowEvent(
            content="关注了主播",
            user_id="uid_005",
            user_name="忠实粉丝",
        )
        assert event.user_id == "uid_005"
        assert event.user_name == "忠实粉丝"


class TestLiveEventMetadata:
    """LiveEvent 元数据和时间戳相关测试。"""

    def test_event_with_metadata(self):
        """测试带自定义 metadata 的事件。"""
        event = LiveEvent(
            content="hello",
            metadata={"room_id": "12345", "platform": "bilibili"},
        )
        assert event.metadata == {"room_id": "12345", "platform": "bilibili"}

    def test_event_default_metadata_is_empty(self):
        """测试默认 metadata 为空字典。"""
        event = LiveEvent(content="hello")
        assert event.metadata == {}

    def test_event_timestamp_auto_set(self):
        """测试 timestamp 自动生成。"""
        before = datetime.now()
        event = LiveEvent(content="hello")
        after = datetime.now()
        # 时间戳应在创建前后之间
        assert before <= event.timestamp <= after


class TestLiveEventImmutability:
    """事件模型不可变性测试。"""

    def test_danmaku_event_frozen(self):
        """测试弹幕事件不可修改。"""
        event = DanmakuEvent(content="你好", user_name="test_user")
        with pytest.raises(ValidationError):
            event.user_name = "changed"

    def test_gift_event_frozen(self):
        """测试礼物事件不可修改。"""
        event = GiftEvent(content="送礼物", gift_name="火箭", coin_value=500)
        with pytest.raises(ValidationError):
            event.gift_name = "changed"
