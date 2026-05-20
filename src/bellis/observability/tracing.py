"""链路追踪模块 — 提供基于 span 的分布式追踪能力。

本模块实现了轻量级的链路追踪器，支持嵌套 span、自动计时、
异常标记与追踪记录导出，用于观测 Agent 主循环中各阶段的执行耗时与状态。
"""

from __future__ import annotations

import logging
import time
from collections.abc import Generator
from contextlib import contextmanager
from typing import Any

logger = logging.getLogger(__name__)

# 默认最大追踪记录保留数量
MAX_TRACES = 1000


class TraceSpan:
    """追踪跨度，表示一个具有起止时间的操作单元。

    支持嵌套结构：子 span 会被添加到父 span 的 children 列表中，
    形成树状调用链路。

    Attributes:
        name: Span 名称，通常对应操作或阶段名称。
        metadata: 附加元数据字典。
        start_time: Span 开始时间（单调时钟秒数）。
        end_time: Span 结束时间（单调时钟秒数）。
        input_data: Span 的输入数据。
        output_data: Span 的输出数据。
        children: 子 Span 列表。
    """

    def __init__(self, name: str, metadata: dict | None = None) -> None:
        self.name = name
        self.metadata = metadata or {}
        self.start_time: float = 0.0
        self.end_time: float = 0.0
        self.input_data: Any = None
        self.output_data: Any = None
        self.children: list[TraceSpan] = []

    @property
    def duration_ms(self) -> float:
        """计算 Span 的执行耗时（毫秒）。

        Returns:
            从 start_time 到 end_time 的毫秒数。
        """
        return (self.end_time - self.start_time) * 1000

    def to_dict(self) -> dict:
        """将 Span 转换为可序列化的字典。

        input/output 数据会被截断为前 200 个字符以避免输出过大。

        Returns:
            包含 name、时间、耗时、元数据、输入输出及子 span 的字典。
        """
        return {
            "name": self.name,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "duration_ms": self.duration_ms,
            "metadata": self.metadata,
            # 截断输入输出数据，避免序列化结果过大
            "input": str(self.input_data)[:200] if self.input_data else None,
            "output": str(self.output_data)[:200] if self.output_data else None,
            "children": [child.to_dict() for child in self.children],
        }


class Tracer:
    """轻量级链路追踪器。

    通过 ``span`` 上下文管理器创建追踪跨度，支持嵌套调用。
    当追踪记录数量超过上限时，自动淘汰最旧的记录。

    Attributes:
        _traces: 顶层 TraceSpan 列表。
        _current: 当前活跃的 Span，用于构建嵌套关系。
        _max_traces: 最大追踪记录保留数量。
    """

    def __init__(self, max_traces: int = MAX_TRACES) -> None:
        self._traces: list[TraceSpan] = []
        self._current: TraceSpan | None = None
        self._max_traces = max_traces

    @contextmanager
    def span(self, name: str, metadata: dict | None = None) -> Generator[TraceSpan]:
        """创建一个追踪跨度上下文管理器。

        若当前已有活跃 span，则新 span 作为其子 span；
        否则作为顶层 span 加入追踪列表。异常发生时会在
        span 的 metadata 中记录错误信息。

        Args:
            name: Span 名称。
            metadata: 附加元数据。

        Yields:
            当前创建的 TraceSpan 实例。

        Raises:
            Exception: 向上传播业务异常，同时在 span 中标记错误信息。
        """
        span = TraceSpan(name, metadata)
        span.start_time = time.monotonic()
        if self._current is not None:
            # 嵌套场景：作为当前活跃 span 的子 span
            self._current.children.append(span)
        else:
            # 顶层场景：直接加入追踪列表
            self._traces.append(span)
            # 超过上限时淘汰最旧的
            if len(self._traces) > self._max_traces:
                self._traces = self._traces[-self._max_traces:]
        # 保存并切换当前活跃 span，退出时恢复
        prev = self._current
        self._current = span
        try:
            yield span
        except Exception as exc:
            # 将异常信息记录到 span 元数据中，便于后续排查
            span.metadata["error"] = f"{type(exc).__name__}: {exc}"
            logger.error("Span '%s' 发生异常: %s", name, exc, exc_info=True)
            raise
        finally:
            span.end_time = time.monotonic()
            # 恢复上一层活跃 span
            self._current = prev

    def get_traces(self) -> list[dict]:
        """返回所有顶层追踪记录的字典表示。

        Returns:
            顶层 TraceSpan 的 to_dict() 结果列表。
        """
        return [trace.to_dict() for trace in self._traces]

    def clear(self) -> None:
        """清空所有追踪记录并重置当前活跃 span。"""
        self._traces.clear()
        self._current = None
