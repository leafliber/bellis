from __future__ import annotations

from dataclasses import dataclass

from textual.design import ColorSystem


@dataclass
class BellisTheme:
    name: str = "dark"
    background: str = "#1e1e2e"
    surface: str = "#313244"
    primary: str = "#89b4fa"
    secondary: str = "#a6adc8"
    accent: str = "#f5c2e7"
    error: str = "#f38ba8"
    warning: str = "#fab387"
    success: str = "#a6e3a1"
    text: str = "#cdd6f4"
    text_muted: str = "#6c7086"
    danmaku_color: str = "#89b4fa"
    gift_color: str = "#f9e2af"
    command_color: str = "#f38ba8"
    system_color: str = "#6c7086"

    def to_color_system(self) -> ColorSystem:
        return ColorSystem(
            primary=self.primary,
            secondary=self.secondary,
            accent=self.accent,
            warning=self.warning,
            error=self.error,
            success=self.success,
            surface=self.surface,
            background=self.background,
        )

    def to_css_vars(self) -> dict[str, str]:
        return {
            "danmaku-color": self.danmaku_color,
            "gift-color": self.gift_color,
            "command-color": self.command_color,
            "system-color": self.system_color,
        }


_LIGHT_THEME = BellisTheme(
    name="light",
    background="#eff1f5",
    surface="#ccd0da",
    primary="#1e66f5",
    secondary="#6c6f85",
    accent="#ea76cb",
    error="#d20f39",
    warning="#fe640b",
    success="#40a02b",
    text="#4c4f69",
    text_muted="#9ca0b0",
    danmaku_color="#1e66f5",
    gift_color="#df8e1d",
    command_color="#d20f39",
    system_color="#9ca0b0",
)

_THEMES: dict[str, BellisTheme] = {
    "dark": BellisTheme(),
    "light": _LIGHT_THEME,
}


def get_theme(name: str) -> BellisTheme:
    if name not in _THEMES:
        raise KeyError(f"Theme '{name}' not found. Available: {list(_THEMES.keys())}")
    return _THEMES[name]


def register_theme(name: str, theme: BellisTheme) -> None:
    _THEMES[name] = theme
