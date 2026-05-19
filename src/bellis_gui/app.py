from __future__ import annotations

from typing import Any

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.theme import Theme
from textual.widgets import Footer, Header

from bellis_gui.adapters.config_adapter import ConfigAdapter
from bellis_gui.adapters.event_adapter import EventAdapter
from bellis_gui.adapters.state_adapter import StateAdapter
from bellis_gui.screens.config_screen import ConfigScreen
from bellis_gui.screens.dashboard import DashboardScreen
from bellis_gui.screens.observability import ObservabilityScreen
from bellis_gui.theme import BellisTheme, get_theme


def _to_textual_theme(bt: BellisTheme) -> Theme:
    return Theme(
        name=bt.name,
        primary=bt.primary,
        secondary=bt.secondary,
        warning=bt.warning,
        error=bt.error,
        success=bt.success,
        accent=bt.accent,
        background=bt.background,
        surface=bt.surface,
        foreground=bt.text,
        dark=(bt.name == "dark"),
        variables={
            "danmaku-color": bt.danmaku_color,
            "gift-color": bt.gift_color,
            "command-color": bt.command_color,
            "system-color": bt.system_color,
        },
    )


class BellisApp(App[None]):
    TITLE = "Bellis"
    SUB_TITLE = "Live Streaming AI Agent"

    CSS_PATH = "styles.tcss"

    BINDINGS = [
        Binding("d", "switch_screen('dashboard')", "Dashboard"),
        Binding("c", "switch_screen('config')", "Config"),
        Binding("o", "switch_screen('observability')", "Observability"),
        Binding("q", "quit", "Quit"),
        Binding("t", "toggle_theme", "Theme"),
    ]

    def __init__(
        self,
        event_bus: Any | None = None,
        config_center: Any | None = None,
        tracer: Any | None = None,
        snapshot_exporter: Any | None = None,
        **kwargs: Any,
    ) -> None:
        self._bellis_theme_name = "dark"
        self._registered_screens: dict[str, type] = {}
        self._registered_widgets: dict[str, type] = {}
        self._event_adapter: EventAdapter | None = None
        self._state_adapter: StateAdapter | None = None
        self._config_adapter: ConfigAdapter | None = None
        self._tracer = tracer
        self._snapshot_exporter = snapshot_exporter
        super().__init__(**kwargs)
        if event_bus is not None:
            self._event_adapter = EventAdapter(event_bus)
        if config_center is not None:
            self._config_adapter = ConfigAdapter(config_center)
        self._state_adapter = StateAdapter()

    def compose(self) -> ComposeResult:
        yield Header()
        yield Footer()

    def on_mount(self) -> None:
        self.register_theme(_to_textual_theme(get_theme("dark")))
        self.register_theme(_to_textual_theme(get_theme("light")))
        self.theme = "dark"
        dashboard = DashboardScreen(
            event_adapter=self._event_adapter,
            state_adapter=self._state_adapter,
            config_adapter=self._config_adapter,
        )
        config_screen = ConfigScreen(config_adapter=self._config_adapter)
        observability = ObservabilityScreen(
            tracer=self._tracer,
            snapshot_exporter=self._snapshot_exporter,
        )
        self.install_screen(dashboard, name="dashboard")
        self.install_screen(config_screen, name="config")
        self.install_screen(observability, name="observability")
        self.push_screen("dashboard")

    async def on_unmount(self) -> None:
        if self._event_adapter is not None:
            await self._event_adapter.stop()
        if self._state_adapter is not None:
            await self._state_adapter.stop()
        if self._config_adapter is not None:
            await self._config_adapter.stop()

    def register_screen(self, name: str, screen_class: type) -> None:
        self._registered_screens[name] = screen_class
        instance = screen_class()
        self.install_screen(instance, name=name)

    def register_widget(self, name: str, widget_class: type) -> None:
        self._registered_widgets[name] = widget_class

    def get_widget_class(self, name: str) -> type | None:
        return self._registered_widgets.get(name)

    def action_toggle_theme(self) -> None:
        self._bellis_theme_name = "light" if self._bellis_theme_name == "dark" else "dark"
        self.theme = self._bellis_theme_name

    @property
    def bellis_theme(self) -> BellisTheme:
        return get_theme(self._bellis_theme_name)

    @property
    def event_adapter(self) -> EventAdapter | None:
        return self._event_adapter

    @property
    def state_adapter(self) -> StateAdapter | None:
        return self._state_adapter

    @property
    def config_adapter(self) -> ConfigAdapter | None:
        return self._config_adapter
