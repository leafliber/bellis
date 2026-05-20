"""命令收集器 — 通过 WebSocket 接收控制命令。"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

import websockets

from bellis.core.events import CommandEvent, LiveEvent
from bellis.plugin.base import InputPlugin, PluginCategory, PluginMeta
from bellis.runtime.bus import EventBus


class CommandCollector(InputPlugin):
    """命令收集器，通过 WebSocket 接收控制命令。"""

    plugin_meta = PluginMeta(
        name="bilibili_command",
        version="0.1.0",
        description="命令收集器，通过 WebSocket 接收控制命令",
        category=PluginCategory.INPUT,
        tags=("bilibili", "command"),
    )

    def __init__(self, bus: EventBus, uri: str = "ws://localhost:8080/command") -> None:
        super().__init__()
        self._bus = bus
        self._uri = uri
        self._ws = None
        self._task: asyncio.Task[None] | None = None
        self._event_queue: asyncio.Queue[LiveEvent] = asyncio.Queue()

    async def _on_start(self) -> None:
        self._task = asyncio.create_task(self._consume_loop())

    async def _on_stop(self) -> None:
        if self._ws is not None:
            await self._ws.close()
            self._ws = None
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def listen(self) -> AsyncIterator[LiveEvent]:
        while self.state.value == "running":
            event = await self._event_queue.get()
            yield event

    async def _consume_loop(self) -> None:
        while self.state.value in ("starting", "running"):
            try:
                async with websockets.connect(self._uri) as ws:
                    self._ws = ws
                    async for message in ws:
                        if self.state.value not in ("starting", "running"):
                            break
                        event = self._parse_message(message)
                        if event is not None:
                            await self._bus.publish(event)
                            await self._event_queue.put(event)
            except asyncio.CancelledError:
                break
            except Exception:
                if self.state.value in ("starting", "running"):
                    await asyncio.sleep(1.0)

    def _parse_message(self, raw: str) -> CommandEvent | None:
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return None
        return CommandEvent(
            content=data.get("content", ""),
            command_type=data.get("command_type", ""),
            payload=data.get("payload", {}),
            metadata=data.get("metadata", {}),
        )
