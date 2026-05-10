from enum import Enum, StrEnum


class EmotionEnum(StrEnum):
    happy = "happy"
    excited = "excited"
    calm = "calm"
    shy = "shy"
    angry = "angry"
    sad = "sad"
    surprised = "surprised"
    neutral = "neutral"


class MotionEnum(StrEnum):
    idle = "idle"
    wave = "wave"
    nod = "nod"
    shake_head = "shake_head"
    bow = "bow"
    clap = "clap"
    point = "point"
    think = "think"
    cheer = "cheer"


class EventPriority(int, Enum):
    CRITICAL = 0
    HIGH = 1
    NORMAL = 2
    LOW = 3


class EventSource(StrEnum):
    DANMAKU = "danmaku"
    GIFT = "gift"
    COMMAND = "command"
    RAG = "rag"
    SYSTEM = "system"


class CommandType(StrEnum):
    SWITCH_TOPIC = "switch_topic"
    FORCE_REPLY = "force_reply"
    SWITCH_PERSONA = "switch_persona"
    INTERRUPT = "interrupt"
    RESUME = "resume"
