from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Vertical
from textual.screen import Screen
from textual.widgets import Button, Input, Static, TabbedContent, TabPane

from bellis_gui.adapters.config_adapter import ConfigAdapter
from bellis_gui.adapters.models import GUIConfig


class PersonaPanel(Vertical):
    DEFAULT_CSS = """
    PersonaPanel {
        padding: 1;
        height: auto;
    }
    PersonaPanel Input {
        margin-bottom: 1;
    }
    """

    def __init__(self, config_adapter: ConfigAdapter | None = None, **kwargs) -> None:
        super().__init__(**kwargs)
        self._config_adapter = config_adapter

    def compose(self) -> ComposeResult:
        yield Static("Persona 名称:")
        yield Input(id="persona-name", placeholder="default")
        yield Static("System Prompt:")
        yield Input(id="persona-system-prompt", placeholder="输入 system prompt...")
        yield Static("TTS Voice:")
        yield Input(id="persona-tts-voice", placeholder="default")
        yield Button("保存 Persona", id="btn-save-persona", variant="primary")

    def load_config(self, config: GUIConfig) -> None:
        active = config.personas.get(config.active_persona)
        if active is None:
            return
        self.query_one("#persona-name", Input).value = active.name
        self.query_one("#persona-system-prompt", Input).value = active.system_prompt
        self.query_one("#persona-tts-voice", Input).value = active.tts_voice

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-save-persona" and self._config_adapter is not None:
            from bellis_gui.adapters.models import GUIPersonaConfig

            persona = GUIPersonaConfig(
                name=self.query_one("#persona-name", Input).value,
                system_prompt=self.query_one("#persona-system-prompt", Input).value,
                tts_voice=self.query_one("#persona-tts-voice", Input).value,
            )
            self._config_adapter.register_persona(persona)


class ModelPanel(Vertical):
    DEFAULT_CSS = """
    ModelPanel {
        padding: 1;
        height: auto;
    }
    ModelPanel Input {
        margin-bottom: 1;
    }
    """

    def __init__(self, config_adapter: ConfigAdapter | None = None, **kwargs) -> None:
        super().__init__(**kwargs)
        self._config_adapter = config_adapter

    def compose(self) -> ComposeResult:
        yield Static("主模型:")
        yield Input(id="model-primary", placeholder="openai:gpt-4o")
        yield Static("降级模型:")
        yield Input(id="model-fallback", placeholder="openai:gpt-4o-mini")
        yield Static("最大重试次数:")
        yield Input(id="model-retries", placeholder="3")
        yield Static("Temperature:")
        yield Input(id="model-temperature", placeholder="0.7")
        yield Button("保存模型配置", id="btn-save-model", variant="primary")

    def load_config(self, config: GUIConfig) -> None:
        self.query_one("#model-primary", Input).value = config.model.primary_model
        self.query_one("#model-fallback", Input).value = config.model.fallback_model
        self.query_one("#model-retries", Input).value = str(config.model.max_retries)
        self.query_one("#model-temperature", Input).value = str(config.model.temperature)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-save-model" and self._config_adapter is not None:
            self._config_adapter.update_model_config(
                primary_model=self.query_one("#model-primary", Input).value,
                fallback_model=self.query_one("#model-fallback", Input).value,
                max_retries=int(self.query_one("#model-retries", Input).value or "3"),
                temperature=float(self.query_one("#model-temperature", Input).value or "0.7"),
            )


class PlatformPanel(Vertical):
    DEFAULT_CSS = """
    PlatformPanel {
        padding: 1;
        height: auto;
    }
    PlatformPanel Input {
        margin-bottom: 1;
    }
    """

    def __init__(self, config_adapter: ConfigAdapter | None = None, **kwargs) -> None:
        super().__init__(**kwargs)
        self._config_adapter = config_adapter

    def compose(self) -> ComposeResult:
        yield Static("弹幕 WebSocket URI:")
        yield Input(id="platform-danmaku-uri", placeholder="ws://localhost:8080/danmaku")
        yield Static("指令 WebSocket URI:")
        yield Input(id="platform-command-uri", placeholder="ws://localhost:8080/command")
        yield Static("最大队列大小:")
        yield Input(id="platform-queue-size", placeholder="1000")
        yield Static("弹幕 QPS 限制:")
        yield Input(id="platform-qps", placeholder="50")
        yield Static("TTS 队列限制:")
        yield Input(id="platform-tts-limit", placeholder="20")
        yield Button("保存平台配置", id="btn-save-platform", variant="primary")

    def load_config(self, config: GUIConfig) -> None:
        self.query_one("#platform-danmaku-uri", Input).value = config.platform.danmaku_ws_uri
        self.query_one("#platform-command-uri", Input).value = config.platform.command_ws_uri
        self.query_one("#platform-queue-size", Input).value = str(config.platform.max_queue_size)
        self.query_one("#platform-qps", Input).value = str(config.platform.danmaku_qps_limit)
        self.query_one("#platform-tts-limit", Input).value = str(config.platform.tts_queue_limit)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-save-platform" and self._config_adapter is not None:
            self._config_adapter.update_platform_config(
                danmaku_ws_uri=self.query_one("#platform-danmaku-uri", Input).value,
                command_ws_uri=self.query_one("#platform-command-uri", Input).value,
                max_queue_size=int(self.query_one("#platform-queue-size", Input).value or "1000"),
                danmaku_qps_limit=int(self.query_one("#platform-qps", Input).value or "50"),
                tts_queue_limit=int(self.query_one("#platform-tts-limit", Input).value or "20"),
            )


class ConfigScreen(Screen):
    DEFAULT_CSS = """
    ConfigScreen {
        layout: vertical;
    }
    ConfigScreen #config-actions {
        height: 3;
        padding: 0 1;
    }
    """

    def __init__(self, config_adapter: ConfigAdapter | None = None, **kwargs) -> None:
        super().__init__(**kwargs)
        self._config_adapter = config_adapter

    def compose(self) -> ComposeResult:
        with TabbedContent():
            with TabPane("Persona"):
                yield PersonaPanel(self._config_adapter, id="persona-panel")
            with TabPane("Model"):
                yield ModelPanel(self._config_adapter, id="model-panel")
            with TabPane("Platform"):
                yield PlatformPanel(self._config_adapter, id="platform-panel")
        with Vertical(id="config-actions"):
            yield Button("🔄 重新加载配置 (YAML)", id="btn-reload-config", variant="warning")

    def on_mount(self) -> None:
        self._refresh()

    def _refresh(self) -> None:
        if self._config_adapter is None:
            return
        config = self._config_adapter.snapshot()
        try:
            self.query_one("#persona-panel", PersonaPanel).load_config(config)
            self.query_one("#model-panel", ModelPanel).load_config(config)
            self.query_one("#platform-panel", PlatformPanel).load_config(config)
        except Exception:
            pass

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-reload-config" and self._config_adapter is not None:
            self._config_adapter.reload_from_yaml("config.yaml")
            self._refresh()
