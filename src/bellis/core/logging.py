"""统一日志配置 — 提供全局日志初始化和标准格式。

使用方式::

    from bellis.core.logging import setup_logging
    setup_logging(level="DEBUG")

在应用启动时调用一次即可。
"""

from __future__ import annotations

import logging
import sys
from typing import Literal

LogLevel = Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]

DEFAULT_FORMAT = "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s"
DEFAULT_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

# 带 OTel trace_id/span_id 的日志格式
OTEL_FORMAT = (
    "%(asctime)s | %(levelname)-8s | "
    "trace_id=%(trace_id)s span_id=%(span_id)s | "
    "%(name)s | %(message)s"
)

# 第三方库日志级别（避免过于嘈杂）
_THIRD_PARTY_LEVELS: dict[str, LogLevel] = {
    "httpcore": "WARNING",
    "httpx": "WARNING",
    "openai": "WARNING",
    "websockets": "WARNING",
    "pydantic_ai": "WARNING",
    "langchain_core": "WARNING",
    "langgraph": "WARNING",
    "opentelemetry": "WARNING",
    "opentelemetry_sdk": "WARNING",
}

# 标记 LoggingInstrumentor 是否已初始化
_logging_instrumented = False


def setup_logging(
    level: LogLevel = "INFO",
    format: str = DEFAULT_FORMAT,
    datefmt: str = DEFAULT_DATE_FORMAT,
    stream: object | None = None,
    enable_otel_correlation: bool = True,
) -> None:
    """初始化全局日志配置。

    当 enable_otel_correlation 为 True 时，自动集成
    opentelemetry-instrumentation-logging，在每条日志中注入
    trace_id 和 span_id，实现日志与追踪的自动关联。

    Args:
        level: 根 logger 级别，默认 INFO。
        format: 日志格式字符串。
        datefmt: 时间格式字符串。
        stream: 输出流，默认 sys.stderr。
        enable_otel_correlation: 是否启用 OTel 日志关联。
    """
    # 启用 OTel 日志关联
    if enable_otel_correlation:
        _setup_otel_logging(format, datefmt, stream)

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


def _setup_otel_logging(
    fallback_format: str = DEFAULT_FORMAT,
    datefmt: str = DEFAULT_DATE_FORMAT,
    stream: object | None = None,
) -> None:
    """集成 opentelemetry-instrumentation-logging，自动注入 trace_id/span_id。

    初始化后日志格式自动切换为包含 trace_id 和 span_id 的版本。
    若 OTel instrumentation 包不可用则静默跳过。
    """
    global _logging_instrumented  # noqa: PLW0603
    if _logging_instrumented:
        return

    try:
        from opentelemetry.instrumentation.logging import LoggingInstrumentor

        LoggingInstrumentor().instrument(
            set_logging_format=True,
            log_format=OTEL_FORMAT,
            log_datefmt=datefmt,
        )
        _logging_instrumented = True
        # LoggingInstrumentor 会重新配置 root handler，需确保第三方库级别仍被降低
    except ImportError:
        # opentelemetry-instrumentation-logging 未安装，跳过
        pass
    except Exception:
        # 其他初始化异常静默处理，不影响日志功能
        pass


def get_logger(name: str) -> logging.Logger:
    """获取标准命名的 logger，等价于 ``logging.getLogger(name)``。

    提供此函数是为了统一获取 logger 的入口，方便未来扩展
    （如自动注入 trace_id、结构化字段等）。
    """
    return logging.getLogger(name)
