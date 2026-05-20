"""Bilibili 直播插件 — 弹幕收集、礼物事件、命令收集。"""

from plugins.bilibili.command_collector import CommandCollector
from plugins.bilibili.danmaku_collector import DanmakuCollector
from plugins.bilibili.gift_collector import GiftCollector

__all__ = ["DanmakuCollector", "GiftCollector", "CommandCollector"]
