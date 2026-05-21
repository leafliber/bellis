"""Gateway 模块 — 前端通信网关。

提供 WebSocket 双向通信能力，将 Agent 状态/事件/响应推送到前端，
并接收前端的控制指令（弹幕、启停、人设切换）。
"""

from bellis.gateway.handlers import GatewayCallbacks
from bellis.gateway.protocol import ClientMessage, ServerMessage
from bellis.gateway.server import Gateway

__all__ = ["Gateway", "GatewayCallbacks", "ClientMessage", "ServerMessage"]
