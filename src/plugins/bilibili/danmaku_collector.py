"""B站弹幕收集器 — 通过 WebSocket 接收弹幕事件。"""

from __future__ import annotations

from bellis.core.events import DanmakuEvent
from bellis.plugin.base import PluginCategory, PluginMeta
from plugins.bilibili._ws_base import BilibiliWSInputPlugin


class DanmakuCollector(BilibiliWSInputPlugin):
    """B站弹幕收集器，通过 WebSocket 接收弹幕事件。"""

    plugin_meta = PluginMeta(
        name="bilibili_danmaku",
        version="0.1.0",
        description="B站弹幕收集器，通过 WebSocket 接收弹幕事件",
        category=PluginCategory.INPUT,
        tags=("bilibili", "danmaku"),
    )

    def __init__(self, uri: str = "ws://localhost:8080/danmaku") -> None:
        super().__init__(uri=uri)

    def _parse_message(self, raw: str) -> DanmakuEvent | None:
        import json

        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return None
        return DanmakuEvent(
            content=data.get("content", ""),
            user_id=data.get("user_id", ""),
            user_name=data.get("user_name", ""),
            user_level=data.get("user_level", 0),
            fan_badge=data.get("fan_badge"),
            metadata=data.get("metadata", {}),
        )
