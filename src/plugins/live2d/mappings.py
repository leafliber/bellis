"""情绪/动作到 Live2D Motion Group 的映射。

参考 AIRI 的 EMOTION_EmotionMotionName_value 映射表，
将 bellis 的 EmotionEnum 和 MotionEnum 映射到 Live2D 模型的 Motion Group 名称。
映射关系后续可通过 config_schema 让用户自定义。
"""

from __future__ import annotations

from bellis.core.enums import EmotionEnum, MotionEnum

# 情绪 → Live2D Motion Group 映射
# 参考 AIRI: happy→Happy, sad→Sad, angry→Angry, think→Think,
# surprised→Surprise, awkward→Awkward, question→Question, neutral→Idle, curious→Curious
EMOTION_MOTION_MAP: dict[EmotionEnum, str] = {
    EmotionEnum.happy: "Happy",
    EmotionEnum.excited: "Happy",
    EmotionEnum.calm: "Idle",
    EmotionEnum.shy: "Awkward",
    EmotionEnum.angry: "Angry",
    EmotionEnum.sad: "Sad",
    EmotionEnum.surprised: "Surprise",
    EmotionEnum.neutral: "Idle",
    EmotionEnum.think: "Think",
    EmotionEnum.awkward: "Awkward",
    EmotionEnum.question: "Question",
    EmotionEnum.curious: "Curious",
}

# 动作 → Live2D Motion Group 映射
MOTION_MOTION_MAP: dict[MotionEnum, str] = {
    MotionEnum.idle: "Idle",
    MotionEnum.wave: "Tap",
    MotionEnum.nod: "Idle",
    MotionEnum.shake_head: "Idle",
    MotionEnum.bow: "Idle",
    MotionEnum.clap: "Happy",
    MotionEnum.point: "Tap",
    MotionEnum.think: "Think",
    MotionEnum.cheer: "Happy",
}
