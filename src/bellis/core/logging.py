"""统一日志配置 — 提供全局日志初始化和标准格式。

使用方式::

    from bellis.core.logging import setup_logging
    setup_logging(level="DEBUG")

或在 CLI 入口调用一次即可。
"""

from __future__ import annotations

import logging
import sys
from typing import Literal

LogLevel = Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]

DEFAULT_FORMAT = "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s"
DEFAULT_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

# 第三方库日志级别（避免过于嘈杂）
_THIRD_PARTY_LEVELS: dict[str, LogLevel] = {
    "httpcore": "WARNING",
    "httpx": "WARNING",
    "openai": "WARNING",
    "websockets": "WARNING",
    "pydantic_ai": "WARNING",
    "langchain_core": "WARNING",
    "langgraph": "WARNING",
}


def setup_logging(
    level: LogLevel = "INFO",
    format: str = DEFAULT_FORMAT,
    datefmt: str = DEFAULT_DATE_FORMAT,
    stream: object | None = None,
) -> None:
    """初始化全局日志配置。

    Args:
        level: 根 logger 级别，默认 INFO。
        format: 日志格式字符串。
        datefmt: 时间格式字符串。
        stream: 输出流，默认 sys.stderr。
    """
    handler = logging.StreamHandler(stream or sys.stderr)
    handler.setFormatter(logging.Formatter(format, datefmt=datefmt))

    root = logging.getLogger()
    # 避免重复添加 handler（如多次调用 setup_logging）
    if not root.handlers:
        root.addHandler(handler)
    root.setLevel(getattr(logging, level))

    # 降低第三方库日志级别
    for name, third_party_level in _THIRD_PARTY_LEVELS.items():
        logging.getLogger(name).setLevel(getattr(logging, third_party_level))


def get_logger(name: str) -> logging.Logger:
    """获取标准命名的 logger，等价于 ``logging.getLogger(name)``。

    提供此函数是为了统一获取 logger 的入口，方便未来扩展
    （如自动注入 trace_id、结构化字段等）。
    """
    return logging.getLogger(name)
