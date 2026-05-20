"""命令收集器 — 通过 WebSocket 接收控制命令。"""

from __future__ import annotations

import json
import logging

from bellis.core.events import CommandEvent
from bellis.plugin.base import PluginCategory, PluginMeta
from plugins.bilibili._ws_base import BilibiliWSInputPlugin

logger = logging.getLogger(__name__)


class CommandCollector(BilibiliWSInputPlugin):
    """命令收集器，通过 WebSocket 接收控制命令。"""

    plugin_meta = PluginMeta(
        name="bilibili_command",
        version="0.1.0",
        description="命令收集器，通过 WebSocket 接收控制命令",
        category=PluginCategory.INPUT,
        tags=("bilibili", "command"),
    )

    def __init__(self, uri: str = "ws://localhost:8080/command") -> None:
        super().__init__(uri=uri)

    def _parse_message(self, raw: str) -> CommandEvent | None:
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            logger.warning("命令消息 JSON 解析失败: %s", raw[:200])
            return None
        return CommandEvent(
            content=data.get("content", ""),
            command_type=data.get("command_type", ""),
            payload=data.get("payload", {}),
            metadata=data.get("metadata", {}),
        )
