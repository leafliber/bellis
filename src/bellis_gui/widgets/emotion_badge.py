from __future__ import annotations

from textual.widgets import Static

from bellis import EmotionEnum
from bellis_gui.adapters.models import EMOTION_ICONS
from bellis_gui.widgets.base import BellisWidget


class EmotionBadge(BellisWidget):
    DEFAULT_CSS = """
    EmotionBadge {
        width: auto;
        height: 1;
        padding: 0 1;
        text-align: center;
    }
    """

    def __init__(self, emotion: EmotionEnum = EmotionEnum.neutral, **kwargs) -> None:
        super().__init__(**kwargs)
        self._emotion = emotion

    def compose(self):
        icon = EMOTION_ICONS.get(self._emotion, "😐")
        yield Static(f"{icon} {self._emotion.value}")

    def set_emotion(self, emotion: EmotionEnum) -> None:
        self._emotion = emotion
        icon = EMOTION_ICONS.get(emotion, "😐")
        self.query_one(Static).update(f"{icon} {emotion.value}")
