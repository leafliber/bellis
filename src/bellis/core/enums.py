"""枚举模块 — 定义系统中使用的所有枚举类型。

包含情感、动作、事件优先级、事件来源、命令类型和动作类型等枚举，
为各模块提供统一的类型安全常量。
"""

from enum import Enum, StrEnum


class EmotionEnum(StrEnum):
    """情感枚举，表示 Agent 当前的情感状态。"""

    happy = "happy"          # 开心
    excited = "excited"      # 兴奋
    calm = "calm"            # 平静
    shy = "shy"              # 害羞
    angry = "angry"          # 生气
    sad = "sad"              # 悲伤
    surprised = "surprised"  # 惊讶
    neutral = "neutral"      # 中性/默认


class MotionEnum(StrEnum):
    """Live2D 动作枚举，表示 Agent 可执行的肢体动作。"""

    idle = "idle"                # 待机
    wave = "wave"                # 挥手
    nod = "nod"                  # 点头
    shake_head = "shake_head"    # 摇头
    bow = "bow"                  # 鞠躬
    clap = "clap"                # 鼓掌
    point = "point"              # 指向
    think = "think"              # 思考
    cheer = "cheer"              # 欢呼


class EventPriority(int, Enum):
    """事件优先级枚举，数值越小优先级越高。"""

    CRITICAL = 0  # 关键：需立即处理（如醒目留言）
    HIGH = 1      # 高：重要事件（如礼物、关注）
    NORMAL = 2    # 普通：常规事件（如弹幕）
    LOW = 3       # 低：可延迟处理（如进场）


class EventSource(StrEnum):
    """事件来源枚举，标识事件的产生渠道。"""

    DANMAKU = "danmaku"        # 弹幕
    GIFT = "gift"              # 礼物
    SUPER_CHAT = "super_chat"  # 醒目留言
    VOICE = "voice"            # 语音输入
    ENTER = "enter"            # 进场
    FOLLOW = "follow"          # 关注
    COMMAND = "command"        # 系统命令
    RAG = "rag"                # RAG 检索
    SYSTEM = "system"          # 系统内部
    IDLE = "idle"              # 空闲触发


class CommandType(StrEnum):
    """命令类型枚举，用于 CommandEvent 中指定控制指令。"""

    SWITCH_TOPIC = "switch_topic"        # 切换话题
    FORCE_REPLY = "force_reply"          # 强制回复
    SWITCH_PERSONA = "switch_persona"    # 切换人格
    INTERRUPT = "interrupt"              # 中断当前流程
    RESUME = "resume"                    # 恢复被中断的流程


class ActionType(StrEnum):
    """动作类型枚举，标识 Action 的执行方式。"""

    speak = "speak"                      # 语音播报
    set_expression = "set_expression"    # 设置 Live2D 表情
    set_motion = "set_motion"            # 设置 Live2D 动作
    reply_danmaku = "reply_danmaku"      # 弹幕回复
    change_bg = "change_bg"              # 切换背景
    tool_call = "tool_call"              # 工具调用
    custom = "custom"                    # 自定义动作
