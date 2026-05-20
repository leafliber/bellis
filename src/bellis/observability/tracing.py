from __future__ import annotations

import logging
import time
from collections.abc import Generator
from contextlib import contextmanager
from typing import Any

logger = logging.getLogger(__name__)

MAX_TRACES = 1000


class TraceSpan:
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
        return (self.end_time - self.start_time) * 1000

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "duration_ms": self.duration_ms,
            "metadata": self.metadata,
            "input": str(self.input_data)[:200] if self.input_data else None,
            "output": str(self.output_data)[:200] if self.output_data else None,
            "children": [child.to_dict() for child in self.children],
        }


class Tracer:
    def __init__(self, max_traces: int = MAX_TRACES) -> None:
        self._traces: list[TraceSpan] = []
        self._current: TraceSpan | None = None
        self._max_traces = max_traces

    @contextmanager
    def span(self, name: str, metadata: dict | None = None) -> Generator[TraceSpan]:
        span = TraceSpan(name, metadata)
        span.start_time = time.monotonic()
        if self._current is not None:
            self._current.children.append(span)
        else:
            self._traces.append(span)
            # 超过上限时淘汰最旧的
            if len(self._traces) > self._max_traces:
                self._traces = self._traces[-self._max_traces:]
        prev = self._current
        self._current = span
        try:
            yield span
        except Exception as exc:
            span.metadata["error"] = f"{type(exc).__name__}: {exc}"
            logger.error("Span '%s' 发生异常: %s", name, exc, exc_info=True)
            raise
        finally:
            span.end_time = time.monotonic()
            self._current = prev

    def get_traces(self) -> list[dict]:
        return [trace.to_dict() for trace in self._traces]

    def clear(self) -> None:
        self._traces.clear()
        self._current = None
