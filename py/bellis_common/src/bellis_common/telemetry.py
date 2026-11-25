"""Minimal structured JSONL telemetry logger (ts_ms/trace_id/span/dur_ms/ok/attrs)."""

from __future__ import annotations

import json
import secrets
import threading
import time
from collections.abc import Generator, Mapping
from contextlib import contextmanager
from pathlib import Path
from types import TracebackType
from typing import IO, Self


def new_trace_id() -> str:
    """Return a random 16-hex-character trace identifier."""
    return secrets.token_hex(8)


class JsonlTelemetry:
    """Append-only structured JSONL span/event writer with explicit ``close()``."""

    def __init__(self, path: Path | str, *, flush: bool = True) -> None:
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._flush = flush
        self._lock = threading.Lock()
        self._file: IO[str] | None = self._path.open("a", encoding="utf-8", newline="\n")

    @property
    def path(self) -> Path:
        return self._path

    def record(
        self,
        span: str,
        *,
        dur_ms: float = 0.0,
        ok: bool = True,
        trace_id: str | None = None,
        attrs: Mapping[str, object] | None = None,
    ) -> dict[str, object]:
        """Write one structured JSONL record and return the serialized dict."""
        event: dict[str, object] = {
            "ts_ms": int(time.time() * 1000),
            "trace_id": trace_id or new_trace_id(),
            "span": span,
            "dur_ms": round(dur_ms, 3),
            "ok": ok,
            "attrs": dict(attrs) if attrs is not None else {},
        }
        line = json.dumps(event, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        with self._lock:
            if self._file is None:
                raise ValueError("JsonlTelemetry is closed")
            self._file.write(line + "\n")
            if self._flush:
                self._file.flush()
        return event

    @contextmanager
    def span(
        self,
        name: str,
        *,
        trace_id: str | None = None,
        attrs: Mapping[str, object] | None = None,
    ) -> Generator[dict[str, object]]:
        """Measure elapsed wall duration of a block and emit a JSONL record on exit."""
        merged: dict[str, object] = dict(attrs) if attrs is not None else {}
        tid = trace_id or new_trace_id()
        start_ns = time.perf_counter_ns()
        ok = True
        try:
            yield merged
        except BaseException as exc:
            ok = False
            merged.setdefault("error", type(exc).__name__)
            raise
        finally:
            dur_ms = (time.perf_counter_ns() - start_ns) / 1_000_000.0
            self.record(name, dur_ms=dur_ms, ok=ok, trace_id=tid, attrs=merged)

    def close(self) -> None:
        with self._lock:
            if self._file is not None:
                self._file.close()
                self._file = None

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()
