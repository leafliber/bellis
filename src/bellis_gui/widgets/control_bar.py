from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Horizontal
from textual.widgets import Button, Input, Select

from bellis_gui.adapters.config_adapter import ConfigAdapter
from bellis_gui.widgets.base import BellisWidget


class ControlBar(BellisWidget):
    DEFAULT_CSS = """
    ControlBar {
        width: 1fr;
        height: 3;
        padding: 0 1;
    }
    ControlBar Horizontal {
        height: 1;
    }
    ControlBar Button {
        margin-right: 1;
    }
    ControlBar Select {
        width: 20;
        margin-right: 1;
    }
    ControlBar Input {
        width: 1fr;
    }
    """

    def __init__(self, config_adapter: ConfigAdapter | None = None, **kwargs) -> None:
        super().__init__(**kwargs)
        self._config_adapter = config_adapter

    def compose(self) -> ComposeResult:
        with Horizontal():
            yield Button("▶ 启动", id="btn-start", variant="success")
            yield Button("⏹ 停止", id="btn-stop", variant="error")
            yield Select([], prompt="切换 Persona", id="select-persona")
            yield Input(placeholder="发送指令...", id="input-command")

    def on_mount(self) -> None:
        self._refresh_persona_list()

    def _refresh_persona_list(self) -> None:
        if self._config_adapter is None:
            return
        config = self._config_adapter.snapshot()
        select = self.query_one("#select-persona", Select)
        options = [(name, name) for name in config.personas.keys()]
        select.set_options(options)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-start":
            self.post_message(ControlBar.StartRequested())
        elif event.button.id == "btn-stop":
            self.post_message(ControlBar.StopRequested())

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "input-command" and event.value.strip():
            self.post_message(ControlBar.CommandSent(event.value.strip()))
            event.input.value = ""

    def on_select_changed(self, event: Select.Changed) -> None:
        if event.select.id == "select-persona" and event.value != Select.BLANK:
            self.post_message(ControlBar.PersonaSwitched(str(event.value)))

    class StartRequested:
        pass

    class StopRequested:
        pass

    class CommandSent:
        def __init__(self, command: str) -> None:
            self.command = command

    class PersonaSwitched:
        def __init__(self, persona: str) -> None:
            self.persona = persona
