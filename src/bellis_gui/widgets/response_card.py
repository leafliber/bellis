from __future__ import annotations

from textual.widgets import Static

from bellis_gui.adapters.models import GUIResponse
from bellis_gui.widgets.base import BellisWidget


class ResponseCard(BellisWidget):
    DEFAULT_CSS = """
    ResponseCard {
        width: 1fr;
        height: auto;
        padding: 1;
    }
    """

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._current: GUIResponse | None = None

    def compose(self):
        yield Static(id="response-text", classes="response-field")
        yield Static(id="response-meta", classes="response-field")

    def update_response(self, response: GUIResponse) -> None:
        self._current = response
        text_widget = self.query_one("#response-text", Static)
        meta_widget = self.query_one("#response-meta", Static)
        text_widget.update(response.text)
        target = f" → @{response.target_user}" if response.target_user else ""
        meta = (
            f"🎭 {response.emotion.value} | 🤖 {response.motion.value} | "
            f"🔊 {response.tts_speed:.1f}x | ⏱ {response.motion_duration:.1f}s{target}"
        )
        meta_widget.update(meta)
