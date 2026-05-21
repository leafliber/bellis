"""WebSocket 服务端 — 管理客户端连接、消息收发与广播。

职责：
1. 管理 WebSocket 连接的生命周期（接入、断开、心跳）
2. 将序列化后的协议消息广播到所有客户端
3. 接收客户端消息，委托给 handlers 处理
4. 提供异步上下文管理器接口，支持优雅启停
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING

import websockets

from bellis.gateway.handlers import GatewayCallbacks, handle_client_message
from bellis.gateway.protocol import ClientMessage, ServerMessage
from bellis.gateway.serializers import (
    serialize_event,
    serialize_response,
    serialize_state,
)

if TYPE_CHECKING:
    from bellis.core.events import LiveEvent
    from bellis.core.state import AgentState

logger = logging.getLogger(__name__)


class Gateway:
    """前端通信网关，管理 WebSocket 连接与消息双向流转。

    Attributes:
        _host: 监听地址。
        _port: 监听端口。
        _callbacks: 业务回调接口。
        _clients: 当前连接的 WebSocket 客户端集合。
        _server: websockets 底层服务实例。
    """

    def __init__(
        self,
        callbacks: GatewayCallbacks,
        host: str = "localhost",
        port: int = 8765,
    ) -> None:
        self._host = host
        self._port = port
        self._callbacks = callbacks
        self._clients: set[websockets.WebSocketServerProtocol] = set()
        self._server: websockets.WebSocketServer | None = None

    @property
    def client_count(self) -> int:
        """当前连接的客户端数量。"""
        return len(self._clients)

    # ─── 生命周期 ──────────────────────────────────────────────────

    async def start(self) -> None:
        """启动 WebSocket 服务。"""
        self._server = await websockets.serve(
            self._handle_client,
            self._host,
            self._port,
        )
        logger.info("Gateway 已启动: ws://%s:%d", self._host, self._port)

    async def stop(self) -> None:
        """优雅关闭 WebSocket 服务，断开所有客户端。"""
        if self._server is None:
            return
        self._server.close()
        await self._server.wait_closed()
        self._clients.clear()
        self._server = None
        logger.info("Gateway 已停止")

    # ─── 广播 ──────────────────────────────────────────────────────

    async def broadcast(self, msg: ServerMessage) -> None:
        """向所有客户端广播协议消息，自动清理已断开连接。"""
        data = msg.model_dump_json()
        dead: set[websockets.WebSocketServerProtocol] = set()
        for ws in self._clients:
            try:
                await ws.send(data)
            except websockets.ConnectionClosed:
                dead.add(ws)
        self._clients -= dead

    async def broadcast_event(self, event: LiveEvent) -> None:
        """序列化并广播 LiveEvent。"""
        await self.broadcast(serialize_event(event))

    async def broadcast_state(self, state: AgentState) -> None:
        """序列化并广播 AgentState。"""
        await self.broadcast(serialize_state(state))

    async def broadcast_response(self, state: AgentState) -> None:
        """序列化并广播 LiveResponse（如有）。"""
        msg = serialize_response(state)
        if msg is not None:
            await self.broadcast(msg)

    # ─── 客户端处理 ────────────────────────────────────────────────

    async def _handle_client(
        self,
        websocket: websockets.WebSocketServerProtocol,
    ) -> None:
        """处理单个客户端连接的完整生命周期。"""
        self._clients.add(websocket)
        remote = websocket.remote_address
        logger.info("客户端连接: %s (当前 %d 个)", remote, len(self._clients))

        try:
            async for raw in websocket:
                try:
                    data = json.loads(raw)
                    msg = ClientMessage(**data)
                    await handle_client_message(msg, self._callbacks)
                except (json.JSONDecodeError, ValueError):
                    logger.warning("无效客户端消息: %s", raw[:100])
        except websockets.ConnectionClosed:
            pass
        finally:
            self._clients.discard(websocket)
            logger.info("客户端断开: %s (当前 %d 个)", remote, len(self._clients))
