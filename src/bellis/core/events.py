"""事件模块 — 定义直播场景下的各类事件模型。

所有事件均继承自 LiveEvent，通过 source 字段区分事件来源，
通过 priority 字段决定处理优先级。事件模型设置为不可变（frozen），
确保在多节点间传递时不会被意外修改。
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from bellis.core.enums import CommandType, EventPriority, EventSource


class LiveEvent(BaseModel):
    """直播事件基类。

    Attributes:
        content: 事件内容文本。
        priority: 事件优先级，默认 NORMAL。
        source: 事件来源，默认 SYSTEM。
        timestamp: 事件产生时间戳。
        metadata: 附加元数据，供下游节点使用。

    Note:
        模型设置为 frozen=True，实例创建后不可修改。
    """

    content: str
    priority: EventPriority = EventPriority.NORMAL
    source: EventSource = EventSource.SYSTEM
    timestamp: datetime = Field(default_factory=datetime.now)
    metadata: dict = Field(default_factory=dict)

    model_config = {"frozen": True}


class DanmakuEvent(LiveEvent):
    """弹幕事件，来源于观众发送的弹幕消息。

    Attributes:
        source: 固定为 DANMAKU。
        user_id: 发送者用户 ID。
        user_name: 发送者用户名。
        user_level: 发送者用户等级。
        fan_badge: 粉丝牌名称，非粉丝则为 None。
    """

    source: EventSource = EventSource.DANMAKU
    user_id: str = ""
    user_name: str = ""
    user_level: int = 0
    fan_badge: str | None = None


class GiftEvent(LiveEvent):
    """礼物事件，来源于观众赠送的虚拟礼物。

    Attributes:
        source: 固定为 GIFT。
        priority: 默认 HIGH，礼物事件需优先处理。
        user_id: 赠送者用户 ID。
        user_name: 赠送者用户名。
        gift_name: 礼物名称。
        gift_count: 礼物数量。
        coin_value: 礼物对应的虚拟币价值。
    """

    source: EventSource = EventSource.GIFT
    priority: EventPriority = EventPriority.HIGH
    user_id: str = ""
    user_name: str = ""
    gift_name: str = ""
    gift_count: int = 1
    coin_value: int = 0


class SuperChatEvent(LiveEvent):
    """醒目留言事件，来源于观众付费发送的醒目留言。

    Attributes:
        source: 固定为 SUPER_CHAT。
        priority: 固定为 CRITICAL，醒目留言需立即处理。
        user_id: 发送者用户 ID。
        user_name: 发送者用户名。
        price: 付费金额。
        duration: 留言展示时长（秒）。
    """

    source: EventSource = EventSource.SUPER_CHAT
    priority: EventPriority = EventPriority.CRITICAL
    user_id: str = ""
    user_name: str = ""
    price: int = 0
    duration: int = 0


class VoiceEvent(LiveEvent):
    """语音事件，来源于语音识别输入。

    Attributes:
        source: 固定为 VOICE。
        audio_data: 原始音频二进制数据。
        language: 音频语言代码，默认 "zh"。
    """

    source: EventSource = EventSource.VOICE
    audio_data: bytes = b""
    language: str = "zh"


class EnterEvent(LiveEvent):
    """进场事件，来源于观众进入直播间。

    Attributes:
        source: 固定为 ENTER。
        priority: 默认 LOW，进场事件可延迟处理。
        user_id: 进场用户 ID。
        user_name: 进场用户名。
    """

    source: EventSource = EventSource.ENTER
    priority: EventPriority = EventPriority.LOW
    user_id: str = ""
    user_name: str = ""


class FollowEvent(LiveEvent):
    """关注事件，来源于观众关注主播。

    Attributes:
        source: 固定为 FOLLOW。
        priority: 默认 HIGH，关注事件需优先处理。
        user_id: 关注者用户 ID。
        user_name: 关注者用户名。
    """

    source: EventSource = EventSource.FOLLOW
    priority: EventPriority = EventPriority.HIGH
    user_id: str = ""
    user_name: str = ""


class CommandEvent(LiveEvent):
    """命令事件，来源于系统内部或外部控制指令。

    Attributes:
        source: 固定为 COMMAND。
        priority: 固定为 CRITICAL，命令需立即执行。
        command_type: 命令类型，决定执行逻辑。
        payload: 命令附加参数。
    """

    source: EventSource = EventSource.COMMAND
    priority: EventPriority = EventPriority.CRITICAL
    command_type: CommandType = CommandType.SWITCH_TOPIC
    payload: dict = Field(default_factory=dict)


class RAGEvent(LiveEvent):
    """RAG 检索事件，由知识库检索触发。

    Attributes:
        source: 固定为 RAG。
        query: 检索查询文本。
        retrieved_docs: 检索到的文档片段列表。
    """

    source: EventSource = EventSource.RAG
    query: str = ""
    retrieved_docs: list[str] = Field(default_factory=list)


class IdleEvent(LiveEvent):
    """空闲事件，由空闲监控器在长时间无交互时触发。

    Attributes:
        source: 固定为 IDLE。
        priority: 默认 LOW，空闲事件优先级最低。
    """

    source: EventSource = EventSource.IDLE
    priority: EventPriority = EventPriority.LOW
