from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.screen import Screen
from textual.widgets import Static

from bellis_gui.adapters.config_adapter import ConfigAdapter
from bellis_gui.adapters.event_adapter import EventAdapter
from bellis_gui.adapters.state_adapter import StateAdapter
from bellis_gui.widgets.control_bar import ControlBar
from bellis_gui.widgets.event_log import EventLog
from bellis_gui.widgets.response_card import ResponseCard
from bellis_gui.widgets.state_panel import StatePanel


class DashboardScreen(Screen):
    DEFAULT_CSS = """
    DashboardScreen {
        layout: vertical;
    }
    DashboardScreen #main-area {
        height: 1fr;
    }
    DashboardScreen #left-panel {
        width: 2fr;
    }
    DashboardScreen #right-panel {
        width: 1fr;
    }
    DashboardScreen #control-area {
        height: auto;
    }
    DashboardScreen #section-title {
        text-style: bold;
        padding: 0 1;
        height: 1;
    }
    """

    def __init__(
        self,
        event_adapter: EventAdapter | None = None,
        state_adapter: StateAdapter | None = None,
        config_adapter: ConfigAdapter | None = None,
    ) -> None:
        super().__init__()
        self._event_adapter = event_adapter
        self._state_adapter = state_adapter
        self._config_adapter = config_adapter

    def compose(self) -> ComposeResult:
        with Horizontal(id="main-area"):
            with Vertical(id="left-panel"):
                yield Static("📡 事件流", id="section-title")
                yield EventLog(self._event_adapter, id="dashboard-event-log")
            with Vertical(id="right-panel"):
                yield Static("🤖 智能体状态", id="section-title")
                yield StatePanel(self._state_adapter, id="dashboard-state-panel")
                yield Static("💬 最新回复", id="section-title")
                yield ResponseCard(id="dashboard-response-card")
        with Vertical(id="control-area"):
            yield ControlBar(self._config_adapter, id="dashboard-control-bar")

    def on_control_bar_start_requested(self, event: ControlBar.StartRequested) -> None:
        self.app.post_message(DashboardScreen.AgentStartRequested())

    def on_control_bar_stop_requested(self, event: ControlBar.StopRequested) -> None:
        self.app.post_message(DashboardScreen.AgentStopRequested())

    def on_control_bar_command_sent(self, event: ControlBar.CommandSent) -> None:
        self.app.post_message(DashboardScreen.AgentCommand(event.command))

    def on_control_bar_persona_switched(self, event: ControlBar.PersonaSwitched) -> None:
        if self._config_adapter is not None:
            self._config_adapter.switch_persona(event.persona)

    class AgentStartRequested:
        pass

    class AgentStopRequested:
        pass

    class AgentCommand:
        def __init__(self, command: str) -> None:
            self.command = command
