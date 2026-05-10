from bellis import EmotionEnum, EventSource, MotionEnum
from bellis_gui.adapters.models import (
    EMOTION_COLORS,
    EMOTION_ICONS,
    SOURCE_COLORS,
    GUIActionRecord,
    GUIEmotionState,
    GUIEvent,
    GUIResponse,
    GUISceneContext,
    GUIState,
)


class TestEventLog:
    def test_event_item_display_text(self):
        event = GUIEvent(
            display_text="你好世界",
            source=EventSource.DANMAKU,
            color_tag=SOURCE_COLORS[EventSource.DANMAKU],
            user_name="viewer1",
            priority_name="NORMAL",
        )
        assert event.display_text == "你好世界"
        assert event.source == EventSource.DANMAKU
        assert event.user_name == "viewer1"

    def test_event_item_no_user(self):
        event = GUIEvent(
            display_text="系统消息",
            source=EventSource.SYSTEM,
            color_tag=SOURCE_COLORS[EventSource.SYSTEM],
        )
        assert event.user_name == ""
        assert event.source == EventSource.SYSTEM

    def test_event_item_gift(self):
        event = GUIEvent(
            display_text="送出火箭",
            source=EventSource.GIFT,
            color_tag=SOURCE_COLORS[EventSource.GIFT],
            user_name="fan1",
            priority_name="HIGH",
        )
        assert event.source == EventSource.GIFT
        assert event.color_tag == SOURCE_COLORS[EventSource.GIFT]

    def test_event_item_command(self):
        event = GUIEvent(
            display_text="切换话题",
            source=EventSource.COMMAND,
            color_tag=SOURCE_COLORS[EventSource.COMMAND],
            priority_name="CRITICAL",
        )
        assert event.source == EventSource.COMMAND
        assert event.color_tag == SOURCE_COLORS[EventSource.COMMAND]


class TestStatePanel:
    def test_emotion_display_data(self):
        emotion = GUIEmotionState(
            current=EmotionEnum.happy,
            intensity=0.8,
            icon=EMOTION_ICONS[EmotionEnum.happy],
            color=EMOTION_COLORS[EmotionEnum.happy],
        )
        assert emotion.current == EmotionEnum.happy
        assert emotion.intensity == 0.8
        assert emotion.icon == "😊"
        assert emotion.color == "#a6e3a1"

    def test_scene_display_data(self):
        scene = GUISceneContext(
            stream_title="测试直播",
            streamer_name="主播",
            viewer_count=500,
            topic="闲聊",
            phase="active",
        )
        assert scene.stream_title == "测试直播"
        assert scene.viewer_count == 500

    def test_action_list_data(self):
        actions = [
            GUIActionRecord(
                action_type="response",
                description="你好",
                emotion=EmotionEnum.happy,
                motion=MotionEnum.wave,
            ),
            GUIActionRecord(
                action_type="idle",
                description="等待中",
                emotion=EmotionEnum.calm,
                motion=MotionEnum.idle,
            ),
        ]
        assert len(actions) == 2
        assert actions[0].emotion == EmotionEnum.happy
        assert actions[1].motion == MotionEnum.idle

    def test_gui_state_with_all_fields(self):
        state = GUIState(
            emotion=GUIEmotionState(
                current=EmotionEnum.excited,
                intensity=0.9,
                icon=EMOTION_ICONS[EmotionEnum.excited],
                color=EMOTION_COLORS[EmotionEnum.excited],
            ),
            scene=GUISceneContext(viewer_count=1000),
            recent_actions=[
                GUIActionRecord(
                    action_type="gift_response",
                    description="感谢礼物",
                    emotion=EmotionEnum.excited,
                    motion=MotionEnum.cheer,
                ),
            ],
            state_version=10,
            event_queue_size=5,
            tts_queue_size=2,
        )
        assert state.emotion.current == EmotionEnum.excited
        assert state.scene.viewer_count == 1000
        assert state.state_version == 10
        assert state.event_queue_size == 5


class TestResponseCard:
    def test_response_display_data(self):
        response = GUIResponse(
            text="感谢你的礼物！",
            emotion=EmotionEnum.happy,
            motion=MotionEnum.wave,
            tts_speed=1.2,
            target_user="fan1",
            motion_duration=2.0,
        )
        assert response.text == "感谢你的礼物！"
        assert response.emotion == EmotionEnum.happy
        assert response.motion == MotionEnum.wave
        assert response.tts_speed == 1.2
        assert response.target_user == "fan1"
        assert response.motion_duration == 2.0

    def test_response_no_target(self):
        response = GUIResponse(
            text="大家好！",
            emotion=EmotionEnum.calm,
            motion=MotionEnum.idle,
        )
        assert response.target_user is None

    def test_response_defaults(self):
        response = GUIResponse()
        assert response.text == ""
        assert response.emotion == EmotionEnum.neutral
        assert response.motion == MotionEnum.idle
        assert response.tts_speed == 1.0


class TestEmotionBadge:
    def test_all_emotions_have_icons(self):
        for emotion in EmotionEnum:
            assert emotion in EMOTION_ICONS
            assert isinstance(EMOTION_ICONS[emotion], str)
            assert len(EMOTION_ICONS[emotion]) > 0

    def test_all_emotions_have_colors(self):
        for emotion in EmotionEnum:
            assert emotion in EMOTION_COLORS
            assert EMOTION_COLORS[emotion].startswith("#")

    def test_specific_emotion_mappings(self):
        assert EMOTION_ICONS[EmotionEnum.happy] == "😊"
        assert EMOTION_ICONS[EmotionEnum.angry] == "😠"
        assert EMOTION_ICONS[EmotionEnum.neutral] == "😐"
        assert EMOTION_ICONS[EmotionEnum.surprised] == "😲"


class TestControlBar:
    def test_source_colors_completeness(self):
        for source in EventSource:
            assert source in SOURCE_COLORS

    def test_source_color_values(self):
        assert SOURCE_COLORS[EventSource.DANMAKU] == "danmaku-color"
        assert SOURCE_COLORS[EventSource.GIFT] == "gift-color"
        assert SOURCE_COLORS[EventSource.COMMAND] == "command-color"
        assert SOURCE_COLORS[EventSource.SYSTEM] == "system-color"
