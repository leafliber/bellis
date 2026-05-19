from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

import websockets

from bellis.core.events import CommandEvent, LiveEvent
from bellis.input.bus import EventBus
from bellis.input.collectors.base import BaseCollector
from bellis.plugins.base import InputPlugin


class CommandCollector(BaseCollector, InputPlugin):
    """命令收集器，同时实现 BaseCollector 和 InputPlugin 接口。"""

    def __init__(self, bus: EventBus, uri: str = "ws://localhost:8080/command") -> None:
        BaseCollector.__init__(self, bus)
        self._uri = uri
        self._ws = None
        self._task: asyncio.Task[None] | None = None
        self._running = False
        self._event_queue: asyncio.Queue[LiveEvent] = asyncio.Queue()

    async def start(self) -> None:
        self._running = True
        self._task = asyncio.create_task(self._consume_loop())

    async def stop(self) -> None:
        self._running = False
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
        """InputPlugin 接口：产生事件流。"""
        while self._running:
            event = await self._event_queue.get()
            yield event

    async def _consume_loop(self) -> None:
        while self._running:
            try:
                async with websockets.connect(self._uri) as ws:
                    self._ws = ws
                    async for message in ws:
                        if not self._running:
                            break
                        event = self._parse_message(message)
                        if event is not None:
                            await self._bus.publish(event)
                            await self._event_queue.put(event)
            except asyncio.CancelledError:
                break
            except Exception:
                if self._running:
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
