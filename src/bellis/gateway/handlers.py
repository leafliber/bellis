"""客户端指令处理器。

解析前端发来的 ClientMessage，通过 GatewayCallbacks 回调接口
与 BellisApp 交互，实现控制面逻辑（弹幕注入、Agent 启停、人设切换、配置更新）。
"""

from __future__ import annotations

import logging

from bellis.gateway.protocol import ClientMessage

logger = logging.getLogger(__name__)


class GatewayCallbacks:
    """Gateway 与 BellisApp 的交互接口。

    由 BellisApp 实现并注入到 Gateway，实现依赖倒置。
    Gateway 不直接引用 BellisApp 的内部属性。
    """

    async def on_command(self, text: str) -> None:
        """前端发送弹幕/命令。"""
        raise NotImplementedError

    async def on_start_agent(self) -> None:
        """前端请求启动 Agent。"""
        raise NotImplementedError

    async def on_stop_agent(self) -> None:
        """前端请求停止 Agent。"""
        raise NotImplementedError

    async def on_switch_persona(self, name: str) -> None:
        """前端请求切换人设。"""
        raise NotImplementedError

    async def on_update_config(self, updates: dict) -> None:
        """前端请求更新配置（局部更新）。"""
        raise NotImplementedError

    async def on_reload_config(self) -> None:
        """前端请求从 YAML 重新加载配置。"""
        raise NotImplementedError


async def handle_client_message(
    msg: ClientMessage,
    callbacks: GatewayCallbacks,
) -> None:
    """处理单条客户端消息。

    Args:
        msg: 解析后的客户端消息。
        callbacks: 回调接口，执行具体业务逻辑。
    """
    match msg.type:
        case "command":
            text = msg.payload.get("command", "").strip()
            if text:
                await callbacks.on_command(text)
        case "start_agent":
            await callbacks.on_start_agent()
        case "stop_agent":
            await callbacks.on_stop_agent()
        case "switch_persona":
            name = msg.payload.get("name", "default")
            await callbacks.on_switch_persona(name)
        case "update_config":
            await callbacks.on_update_config(msg.payload)
        case "reload_config":
            await callbacks.on_reload_config()
        case _:
            logger.warning("未知客户端消息类型: %s", msg.type)
