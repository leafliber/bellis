from __future__ import annotations

from pydantic import BaseModel


class PlatformConfig(BaseModel):
    danmaku_ws_uri: str = "ws://localhost:8080/danmaku"
    command_ws_uri: str = "ws://localhost:8080/command"
    callback_secret: str = ""
    max_queue_size: int = 1000
    danmaku_qps_limit: int = 50
    tts_queue_limit: int = 20
