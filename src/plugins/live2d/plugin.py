"""Live2D 输出插件。

实现 OutputPlugin 接口，通过组合方式持有 WebSocketLive2DDriver，
将 Agent 的 Action 翻译为 Live2D 控制命令发送到前端。
"""

from __future__ import annotations

import logging

from bellis.core.actions import Action
from bellis.core.enums import ActionType, EmotionEnum
from bellis.plugin.base import OutputPlugin, PluginCategory, PluginMeta

from .driver import WebSocketLive2DDriver
from .models import Live2DCommand, Live2DCommandType

logger = logging.getLogger(__name__)


class Live2DPlugin(OutputPlugin):
    """Live2D 输出插件，通过 WebSocket 驱动前端 Live2D 模型。

    将 Agent 产生的 set_expression / set_motion 动作翻译为
    Live2DCommand 发送到前端，由前端 pixi-live2d-display 执行渲染。

    Attributes:
        _driver: WebSocket Live2D 驱动器实例，启动时注入广播函数后创建。
    """

    plugin_meta = PluginMeta(
        name="live2d",
        version="0.1.0",
        description="Live2D 模型控制插件，通过 WebSocket 驱动前端渲染",
        category=PluginCategory.OUTPUT,
        tags=("live2d",),
    )

    config_schema = {
        "enabled": {
            "type": "bool",
            "label": "启用 Live2D",
            "default": True,
            "description": "是否启用 Live2D 渲染",
        },
        "model_url": {
            "type": "str",
            "label": "模型 URL",
            "default": "/data/live2d/shizuku/shizuku.model3.json",
            "description": "Live2D 模型文件 URL（.model3.json），本地文件使用 /data/ 前缀",
        },
    }

    def __init__(self) -> None:
        super().__init__()
        self._driver: WebSocketLive2DDriver | None = None

    def set_broadcast_fn(self, fn: callable) -> None:
        """注入 Gateway 广播函数。

        由 BellisApp 在 Gateway 启动后调用，将广播函数注入到驱动器中。

        Args:
            fn: 接受 Live2DCommand 参数的广播函数。
        """
        self._driver = WebSocketLive2DDriver(fn)
        logger.info("Live2D plugin: broadcast function injected")

    @property
    def driver(self) -> WebSocketLive2DDriver | None:
        """暴露底层驱动器，供 TimelineSync 等组件直接使用。"""
        return self._driver

    async def emit(self, action: Action) -> None:
        """根据 Action 类型驱动 Live2D 模型。

        处理 set_expression 和 set_motion 两种动作类型：
        - set_expression: 将 expression 字符串转为 EmotionEnum 后驱动，
          若 action.parameters 不为空则发送细粒度参数命令
        - set_motion: 直接使用 motion 枚举值驱动

        Args:
            action: 待执行的动作对象。
        """
        if not self._driver:
            logger.warning("Live2D plugin: driver not initialized, skipping action")
            return

        if action.type == ActionType.set_expression:
            if action.parameters:
                # 细粒度参数控制
                await self._driver.send_command(Live2DCommand(
                    type=Live2DCommandType.set_parameters,
                    parameters=action.parameters,
                    intensity=action.intensity,
                ))
            elif action.expression:
                try:
                    emotion = EmotionEnum(action.expression)
                    await self._driver.drive(emotion=emotion, motion=None)
                except ValueError:
                    logger.warning("Live2D plugin: unknown expression '%s'", action.expression)

        elif action.type == ActionType.set_motion and action.motion:
            await self._driver.drive(
                emotion=None,
                motion=action.motion,
                duration=action.motion_duration,
            )
