"""Live2D 控制命令模型。

定义后端向前端发送的 Live2D 控制命令协议，
参考 AIRI 的 Motion Group / Expression / Parameter 控制粒度。
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel


class Live2DCommandType(StrEnum):
    """Live2D 控制命令类型。"""

    set_emotion = "set_emotion"          # 设置情绪 → 触发对应 Motion Group
    play_motion = "play_motion"          # 播放指定 Motion Group + Index
    set_parameter = "set_parameter"      # 设置单个 Cubism 参数
    set_parameters = "set_parameters"    # 批量设置 Cubism 参数
    set_expression = "set_expression"    # 设置表情（exp3.json 定义的表情）
    set_lip_sync = "set_lip_sync"        # 口型同步数据


class Live2DCommand(BaseModel):
    """Live2D 控制命令，通过 WebSocket 发送到前端。

    Attributes:
        type: 命令类型。
        emotion: 情绪名称（set_emotion 时使用）。
        intensity: 情绪/表情强度，0.0 ~ 1.0。
        group: Motion Group 名称（play_motion 时使用）。
        index: Motion 在 Group 中的索引。
        param_id: Cubism 参数 ID（set_parameter 时使用）。
        value: 参数值（set_parameter 时使用）。
        parameters: 批量参数字典（set_parameters 时使用）。
        expression_name: 表情名称（set_expression 时使用）。
        mouth_open: 嘴巴张开程度 0.0 ~ 1.0（set_lip_sync 时使用）。
    """

    type: Live2DCommandType
    # set_emotion
    emotion: str | None = None
    intensity: float = 1.0
    # play_motion
    group: str | None = None
    index: int = 0
    # set_parameter / set_parameters
    param_id: str | None = None
    value: float | None = None
    parameters: dict[str, float] | None = None
    # set_expression
    expression_name: str | None = None
    # set_lip_sync
    mouth_open: float | None = None
