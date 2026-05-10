from __future__ import annotations

import pytest

from bellis import (
    ActionRecord,
    CommandEvent,
    DanmakuEvent,
    EmotionEnum,
    EmotionState,
    EventSource,
    GiftEvent,
    MotionEnum,
    SceneContext,
)
from bellis.config.loader import ConfigCenter
from bellis.input.bus import EventBus
from bellis_gui.adapters.config_adapter import ConfigAdapter
from bellis_gui.adapters.event_adapter import EventAdapter
from bellis_gui.adapters.models import (
    EMOTION_COLORS,
    EMOTION_ICONS,
    SOURCE_COLORS,
    GUIConfig,
    GUIEvent,
    GUIPersonaConfig,
    GUIState,
)
from bellis_gui.adapters.state_adapter import StateAdapter


class TestGUIModels:
    def test_gui_event_creation(self):
        event = GUIEvent(
            display_text="hello",
            source=EventSource.DANMAKU,
            color_tag="danmaku-color",
            user_name="user1",
            priority_name="NORMAL",
        )
        assert event.display_text == "hello"
        assert event.source == EventSource.DANMAKU
        assert event.color_tag == "danmaku-color"

    def test_gui_state_defaults(self):
        state = GUIState()
        assert state.state_version == 0
        assert state.interrupt_flag is False
        assert state.emotion.current == EmotionEnum.neutral

    def test_gui_config_defaults(self):
        config = GUIConfig()
        assert config.active_persona == "default"
        assert len(config.personas) == 0

    def test_emotion_icons_completeness(self):
        for emotion in EmotionEnum:
            assert emotion in EMOTION_ICONS

    def test_emotion_colors_completeness(self):
        for emotion in EmotionEnum:
            assert emotion in EMOTION_COLORS

    def test_source_colors_completeness(self):
        for source in EventSource:
            assert source in SOURCE_COLORS


class TestEventAdapter:
    @pytest.mark.asyncio
    async def test_convert_danmaku_event(self):
        bus = EventBus()
        adapter = EventAdapter(bus)
        event = DanmakuEvent(
            content="你好",
            user_name="viewer1",
            user_level=5,
        )
        gui_event = adapter._convert(event)
        assert gui_event.display_text == "你好"
        assert gui_event.source == EventSource.DANMAKU
        assert gui_event.user_name == "viewer1"
        assert gui_event.color_tag == SOURCE_COLORS[EventSource.DANMAKU]

    @pytest.mark.asyncio
    async def test_convert_gift_event(self):
        bus = EventBus()
        adapter = EventAdapter(bus)
        event = GiftEvent(
            content="送出火箭",
            user_name="fan1",
            gift_name="火箭",
            gift_count=1,
            coin_value=1000,
        )
        gui_event = adapter._convert(event)
        assert gui_event.display_text == "送出火箭"
        assert gui_event.source == EventSource.GIFT
        assert gui_event.user_name == "fan1"
        assert gui_event.color_tag == SOURCE_COLORS[EventSource.GIFT]

    @pytest.mark.asyncio
    async def test_convert_command_event(self):
        bus = EventBus()
        adapter = EventAdapter(bus)
        event = CommandEvent(
            content="切换话题",
            command_type="switch_topic",
            payload={"topic": "新话题"},
        )
        gui_event = adapter._convert(event)
        assert gui_event.source == EventSource.COMMAND
        assert gui_event.color_tag == SOURCE_COLORS[EventSource.COMMAND]


class TestStateAdapter:
    @pytest.mark.asyncio
    async def test_convert_state(self):
        adapter = StateAdapter()
        state = {
            "emotion_state": EmotionState(current=EmotionEnum.happy, intensity=0.8),
            "scene_context": SceneContext(stream_title="测试直播", viewer_count=100, topic="闲聊"),
            "action_history": [
                ActionRecord(
                    action_type="response",
                    description="你好",
                    emotion=EmotionEnum.happy,
                    motion=MotionEnum.wave,
                ),
            ],
            "state_version": 5,
            "interrupt_flag": False,
            "event_queue": [],
            "tts_queue": [],
        }
        gui_state = adapter._convert(state)
        assert gui_state.emotion.current == EmotionEnum.happy
        assert gui_state.emotion.intensity == 0.8
        assert gui_state.scene.stream_title == "测试直播"
        assert gui_state.scene.viewer_count == 100
        assert gui_state.state_version == 5
        assert len(gui_state.recent_actions) == 1

    @pytest.mark.asyncio
    async def test_latest_property(self):
        adapter = StateAdapter()
        assert adapter.latest.state_version == 0
        state = {
            "emotion_state": EmotionState(current=EmotionEnum.excited, intensity=0.9),
            "scene_context": SceneContext(),
            "action_history": [],
            "state_version": 3,
            "interrupt_flag": False,
            "event_queue": [],
            "tts_queue": [],
        }
        adapter.update_source(state)
        assert adapter.latest.state_version == 3
        assert adapter.latest.emotion.current == EmotionEnum.excited

    @pytest.mark.asyncio
    async def test_get_response(self):
        from bellis import LiveResponse

        adapter = StateAdapter()
        state = {
            "live_response": LiveResponse(text="你好！", emotion=EmotionEnum.happy, motion=MotionEnum.wave),
            "emotion_state": EmotionState(),
            "scene_context": SceneContext(),
            "action_history": [],
            "state_version": 1,
            "interrupt_flag": False,
            "event_queue": [],
            "tts_queue": [],
        }
        response = adapter.get_response(state)
        assert response is not None
        assert response.text == "你好！"
        assert response.emotion == EmotionEnum.happy


class TestConfigAdapter:
    def test_snapshot(self):
        cc = ConfigCenter()
        adapter = ConfigAdapter(cc)
        config = adapter.snapshot()
        assert isinstance(config, GUIConfig)
        assert config.active_persona == "default"
        assert "default" in config.personas
        assert "cat_girl" in config.personas

    def test_switch_persona(self):
        cc = ConfigCenter()
        adapter = ConfigAdapter(cc)
        adapter.switch_persona("cat_girl")
        assert cc.active_persona == "cat_girl"
        config = adapter.snapshot()
        assert config.active_persona == "cat_girl"

    def test_register_persona(self):
        cc = ConfigCenter()
        adapter = ConfigAdapter(cc)
        new_persona = GUIPersonaConfig(
            name="custom",
            system_prompt="自定义 persona",
            tts_voice="custom",
        )
        adapter.register_persona(new_persona)
        assert "custom" in cc.personas
        config = adapter.snapshot()
        assert "custom" in config.personas

    def test_update_model_config(self):
        cc = ConfigCenter()
        adapter = ConfigAdapter(cc)
        adapter.update_model_config(primary_model="openai:gpt-4o-mini")
        assert cc.model.primary_model == "openai:gpt-4o-mini"

    def test_update_platform_config(self):
        cc = ConfigCenter()
        adapter = ConfigAdapter(cc)
        adapter.update_platform_config(danmaku_qps_limit=100)
        assert cc.platform.danmaku_qps_limit == 100
