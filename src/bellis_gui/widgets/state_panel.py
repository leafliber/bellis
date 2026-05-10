from __future__ import annotations

from textual.containers import Vertical
from textual.widgets import Static

from bellis_gui.adapters.models import GUIActionRecord, GUIEmotionState, GUISceneContext, GUIState
from bellis_gui.adapters.state_adapter import StateAdapter
from bellis_gui.widgets.base import BellisWidget


class EmotionDisplay(Static):
    DEFAULT_CSS = """
    EmotionDisplay {
        height: 3;
        padding: 0 1;
        text-align: center;
    }
    """

    def update_state(self, emotion: GUIEmotionState) -> None:
        bar_len = int(emotion.intensity * 10)
        bar = "█" * bar_len + "░" * (10 - bar_len)
        self.update(f"{emotion.icon} {emotion.current.value.upper()} [{bar}] {emotion.intensity:.0%}")


class SceneDisplay(Static):
    DEFAULT_CSS = """
    SceneDisplay {
        height: auto;
        padding: 0 1;
    }
    """

    def update_state(self, scene: GUISceneContext) -> None:
        lines = [
            f"📺 {scene.stream_title or '未设置'}",
            f"👤 {scene.streamer_name or '未知'} | 👥 {scene.viewer_count}",
            f"💬 话题: {scene.topic or '无'} | 阶段: {scene.phase}",
        ]
        self.update("\n".join(lines))


class ActionList(Static):
    DEFAULT_CSS = """
    ActionList {
        height: auto;
        padding: 0 1;
    }
    """

    def update_actions(self, actions: list[GUIActionRecord]) -> None:
        if not actions:
            self.update("暂无行为记录")
            return
        lines = []
        for a in actions[-5:]:
            lines.append(f"• [{a.emotion.value}] {a.description}")
        self.update("\n".join(lines))


class StatePanel(BellisWidget):
    DEFAULT_CSS = """
    StatePanel {
        width: 1fr;
        height: auto;
    }
    """

    def __init__(self, state_adapter: StateAdapter | None = None, **kwargs) -> None:
        super().__init__(**kwargs)
        self._state_adapter = state_adapter

    def compose(self):
        with Vertical():
            yield EmotionDisplay(id="emotion-display")
            yield SceneDisplay(id="scene-display")
            yield ActionList(id="action-list")

    async def on_mount(self) -> None:
        if self._state_adapter is not None:
            self.bind_adapter(self._state_adapter)
            await self.start_adapters()
            self.set_interval(0.5, self._poll_state)
            self._refresh(self._state_adapter.latest)

    def _poll_state(self) -> None:
        if self._state_adapter is None:
            return
        state = self._state_adapter.get_nowait()
        if state is not None:
            self._refresh(state)

    def _refresh(self, state: GUIState) -> None:
        self.query_one("#emotion-display", EmotionDisplay).update_state(state.emotion)
        self.query_one("#scene-display", SceneDisplay).update_state(state.scene)
        self.query_one("#action-list", ActionList).update_actions(state.recent_actions)

    def update_state(self, state: GUIState) -> None:
        self._refresh(state)
