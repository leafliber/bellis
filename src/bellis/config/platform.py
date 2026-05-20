"""平台连接与运行参数配置定义。

定义 PlatformConfig 数据模型，包含弹幕 WebSocket 地址、
命令通道、队列限制及空闲监控等参数。
"""

from __future__ import annotations

from pydantic import BaseModel


class PlatformConfig(BaseModel):
    """平台连接与运行参数配置。

    Attributes:
        danmaku_ws_uri: 弹幕 WebSocket 服务地址。
        command_ws_uri: 命令 WebSocket 服务地址。
        callback_secret: 回调签名密钥，用于验证请求来源。
        max_queue_size: 事件队列最大容量。
        danmaku_qps_limit: 弹幕每秒查询限制，用于采样策略。
        tts_queue_limit: TTS 待合成队列最大长度。
        idle_threshold: 空闲判定阈值（秒），超过此时间无弹幕视为空闲。
        idle_monitor_interval: 空闲监控检查间隔（秒）。
    """

    danmaku_ws_uri: str = "ws://localhost:8080/danmaku"
    command_ws_uri: str = "ws://localhost:8080/command"
    callback_secret: str = ""
    max_queue_size: int = 1000
    danmaku_qps_limit: int = 50
    tts_queue_limit: int = 20
    idle_threshold: int = 5
    idle_monitor_interval: float = 2.0
