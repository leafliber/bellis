"""终端输出插件 — 将 Action 打印到控制台，用于调试。"""

from __future__ import annotations

from bellis.core.actions import Action
from bellis.core.enums import ActionType
from bellis.plugin.base import OutputPlugin, PluginCategory, PluginMeta


class ConsoleOutputPlugin(OutputPlugin):
    """终端输出插件，将 Action 打印到控制台。"""

    plugin_meta = PluginMeta(
        name="console_output",
        version="0.1.0",
        description="终端输出插件，将 Action 打印到控制台",
        category=PluginCategory.OUTPUT,
        tags=("debug", "console"),
    )

    async def emit(self, action: Action) -> None:
        """将 Action 格式化打印到控制台。

        根据动作类型输出不同格式：
        - speak: 显示情绪标签、目标用户和文本
        - set_expression: 显示表情名称
        - set_motion: 显示动作名称和持续时间
        - reply_danmaku: 显示目标用户和回复文本
        - 其他类型: 显示动作类型和完整字段

        Args:
            action: 待输出的动作对象。
        """
        if action.type == ActionType.speak:
            emotion = f"[{action.emotion.value}]" if action.emotion else ""
            target = f"@{action.target_user} " if action.target_user else ""
            print(f"  说话 {emotion}: {target}{action.text}")
        elif action.type == ActionType.set_expression:
            print(f"  表情: {action.expression}")
        elif action.type == ActionType.set_motion:
            print(f"  动作: {action.motion.value} ({action.motion_duration}s)")
        elif action.type == ActionType.reply_danmaku:
            print(f"  弹幕回复 @{action.target_user}: {action.reply_text}")
        else:
            print(f"  动作({action.type.value}): {action.model_dump(exclude_defaults=True)}")
