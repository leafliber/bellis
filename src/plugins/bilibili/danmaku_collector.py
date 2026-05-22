"""B站弹幕收集器 — 通过 WebSocket 接收弹幕事件。"""

from __future__ import annotations

import json
import logging

from bellis.core.events import DanmakuEvent
from bellis.plugin.base import PluginCategory, PluginMeta
from plugins.bilibili._ws_base import BilibiliWSInputPlugin

logger = logging.getLogger(__name__)


class DanmakuCollector(BilibiliWSInputPlugin):
    """B站弹幕收集器，通过 WebSocket 接收弹幕事件。"""

    plugin_meta = PluginMeta(
        name="bilibili_danmaku",
        version="0.1.0",
        description="B站弹幕收集器，通过 WebSocket 接收弹幕事件",
        category=PluginCategory.INPUT,
        tags=("bilibili", "danmaku"),
    )

    config_schema = {
        "uri": {
            "type": "str",
            "label": "WebSocket 地址",
            "default": "ws://localhost:8080/danmaku",
            "description": "弹幕 WebSocket 服务地址",
        },
    }

    def __init__(self, uri: str = "ws://localhost:8080/danmaku") -> None:
        """初始化弹幕收集器。

        Args:
            uri: 弹幕 WebSocket 服务地址，默认 ``ws://localhost:8080/danmaku``。
        """
        super().__init__(uri=uri)

    async def _on_start(self) -> None:
        """启动时从 self.config 读取 uri 覆盖构造函数默认值。"""
        if "uri" in self._config:
            self._uri = self._config["uri"]
        await super()._on_start()

    def _parse_message(self, raw: str) -> DanmakuEvent | None:
        """将原始 JSON 字符串解析为 DanmakuEvent。

        Args:
            raw: WebSocket 收到的原始 JSON 字符串。

        Returns:
            解析成功返回 DanmakuEvent，JSON 解析失败返回 None。
        """
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            logger.warning("弹幕消息 JSON 解析失败: %s", raw[:200])
            return None
        return DanmakuEvent(
            content=data.get("content", ""),
            user_id=data.get("user_id", ""),
            user_name=data.get("user_name", ""),
            user_level=data.get("user_level", 0),
            fan_badge=data.get("fan_badge"),
            metadata=data.get("metadata", {}),
        )
