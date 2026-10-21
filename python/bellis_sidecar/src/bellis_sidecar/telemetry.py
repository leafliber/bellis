"""sidecar 一侧的遥测（R-21，见运维“观测”）：在宿主给的目录里写自己的 JSONL，格式与宿主相同。

- 宿主经环境变量 `BELLIS_TELEMETRY`（`SidecarTelemetry` 的 JSON）给出目录与轮转规则，
  文件名以通道角色区分进程（`sidecar.tts-local-<UTC 时刻>-<序号>.jsonl`）。
  没有这个变量、不合格或没有角色时不写，其余照常。
- 宿主调用的 JSON-RPC 参数里带 W3C `traceparent`：以它为父开 span，与宿主在同一个 trace 里。
- 每行一个 OTLP/JSON 的 `ExportTraceServiceRequest`：trace ID 与 span ID 是小写十六进制，
  纳秒时刻与 64 位整数写成十进制字符串，枚举写整数值。
- 属性的准入规则与宿主相同（`packages/telemetry` 的 attributes.ts）：名字只收 `bellis.*`、
  `gen_ai.*` 与 `error.type`，承载内容或观众身份的拒绝；值只收有限的数值、布尔与
  不超过 128 个字符的可打印 ASCII 字符串。
- 写出在守护线程里：有界队列满了丢弃最旧的并计数；按间隔分批写，写失败丢弃这一批并计数，
  只记一次日志；不阻塞事件循环与合成。`close()` 在截止时间内尽量写完。

这里只用标准库与生成的协议模型。
"""

from __future__ import annotations

import contextlib
import io
import json
import logging
import math
import os
import re
import secrets
import threading
import time
from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from pydantic import ValidationError

from .protocol import SidecarTelemetry

ENV_TELEMETRY = 'BELLIS_TELEMETRY'
ENV_ROLE = 'BELLIS_ROLE'
VERSION = '0.1.0'
MAX_STRING_LENGTH = 128
MAX_ATTRIBUTES = 128
MAX_EVENTS = 128

log = logging.getLogger('bellis_sidecar.telemetry')

SpanKind = Literal['internal', 'server', 'client', 'producer', 'consumer']
_KIND = {'internal': 1, 'server': 2, 'client': 3, 'producer': 4, 'consumer': 5}

_HEAD = re.compile(r'^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})')
_ATTRIBUTE_NAME = re.compile(r'^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$')
_PRINTABLE_ASCII = re.compile(r'^[\x20-\x7e]*$')
_ROLE = re.compile(r'^[a-z][a-z0-9_.-]{0,63}$')
_FILE = re.compile(r'^(.+)-(\d{8}T\d{9}Z)-(\d+)\.jsonl$')

_ALLOWED_PREFIXES = ('bellis.', 'gen_ai.')
_ALLOWED_NAMES = frozenset({'error.type'})
_CONTENT_ATTRIBUTES = (
    'gen_ai.input.messages',
    'gen_ai.output.messages',
    'gen_ai.system_instructions',
    'gen_ai.prompt',
    'gen_ai.completion',
    'gen_ai.tool.definitions',
    'gen_ai.tool.call.arguments',
    'gen_ai.tool.call.result',
)
_CONTENT_WORDS = frozenset(
    {
        'text',
        'texts',
        'content',
        'contents',
        'message',
        'messages',
        'body',
        'prompt',
        'prompts',
        'completion',
        'completions',
        'instructions',
        'arguments',
        'result',
        'subtitle',
        'subtitles',
        'spoken',
        'transcript',
        'nickname',
        'nicknames',
        'uname',
        'viewer',
        'viewers',
        'user',
        'open_id',
        'question',
        'option',
        'options',
        'reason',
    }
)


@dataclass(frozen=True)
class TraceContext:
    trace_id: str
    span_id: str
    sampled: bool


def parse_traceparent(value: object) -> TraceContext | None:
    """W3C Trace Context Level 1：接受更高的版本（只读前四段）。

    拒绝版本 ff、全零的 ID 与不合格的写法。
    """
    if not isinstance(value, str) or len(value) < 55:
        return None
    match = _HEAD.match(value)
    if match is None:
        return None
    version, trace_id, span_id, flags = match.groups()
    if version == 'ff' or (version == '00' and len(value) != 55):
        return None
    if len(value) > 55 and value[55] != '-':
        return None
    if trace_id == '0' * 32 or span_id == '0' * 16:
        return None
    return TraceContext(trace_id, span_id, int(flags, 16) & 1 == 1)


def format_traceparent(context: TraceContext) -> str:
    return f'00-{context.trace_id}-{context.span_id}-{"01" if context.sampled else "00"}'


def attribute_allowed(key: str) -> bool:
    if len(key) > 128 or _ATTRIBUTE_NAME.match(key) is None:
        return False
    if any(key == name or key.startswith(f'{name}.') for name in _CONTENT_ATTRIBUTES):
        return False
    if any(segment in _CONTENT_WORDS for segment in key.split('.')):
        return False
    return key in _ALLOWED_NAMES or key.startswith(_ALLOWED_PREFIXES)


def encode_value(value: object) -> dict[str, object] | None:
    """按准入规则编码一个属性值；不合格时返回 None。"""
    if isinstance(value, bool):
        return {'boolValue': value}
    if isinstance(value, int):
        return {'intValue': str(value)} if -(2**63) <= value < 2**63 else None
    if isinstance(value, float):
        return {'doubleValue': value} if math.isfinite(value) else None
    if (
        isinstance(value, str)
        and len(value) <= MAX_STRING_LENGTH
        and _PRINTABLE_ASCII.match(value) is not None
    ):
        return {'stringValue': value}
    return None


def filter_attributes(attributes: Mapping[str, object] | None) -> tuple[dict[str, object], int]:
    """返回留下的属性（键 → 编码后的值）与拒绝的个数；值为 None 视为没给。"""
    accepted: dict[str, object] = {}
    dropped = 0
    for key, value in (attributes or {}).items():
        if value is None:
            continue
        encoded = encode_value(value) if attribute_allowed(key) else None
        if encoded is None:
            dropped += 1
        else:
            accepted[key] = encoded
    return accepted, dropped


def _key_values(encoded: Mapping[str, object]) -> list[dict[str, object]]:
    return [{'key': key, 'value': value} for key, value in encoded.items()]


def _new_id(chars: int) -> str:
    while True:
        value = secrets.token_hex(chars // 2)
        if value != '0' * chars:
            return value


def file_stamp(unix_ms: int) -> str:
    moment = datetime.fromtimestamp(unix_ms / 1000, UTC)
    return f'{moment.strftime("%Y%m%dT%H%M%S")}{unix_ms % 1000:03d}Z'


class Span:
    """空实现：不记录。"""

    @property
    def traceparent(self) -> str | None:
        return None

    def set_attributes(self, attributes: Mapping[str, object]) -> None:
        pass

    def add_event(self, name: str, attributes: Mapping[str, object] | None = None) -> None:
        pass

    def fail(self, error_type: str) -> None:
        pass

    def end(self) -> None:
        pass


class Telemetry:
    """空实现：没有遥测输出时用它，不分配、不写。"""

    def start_span(
        self,
        name: str,
        *,
        parent: str | None = None,
        kind: SpanKind = 'internal',
        attributes: Mapping[str, object] | None = None,
    ) -> Span:
        return _NOOP_SPAN

    def close(self, timeout: float = 1.0) -> None:
        pass


_NOOP_SPAN = Span()
NOOP_TELEMETRY = Telemetry()


@dataclass
class _RecordingSpan(Span):
    _exporter: _Exporter
    name: str
    kind: SpanKind
    trace_id: str
    span_id: str
    parent_span_id: str | None
    start: int = field(default_factory=time.time_ns)
    attributes: dict[str, object] = field(default_factory=lambda: {})
    dropped_attributes: int = 0
    events: list[dict[str, object]] = field(default_factory=lambda: [])
    dropped_events: int = 0
    error: bool = False
    ended: bool = False

    @property
    def traceparent(self) -> str | None:
        return format_traceparent(TraceContext(self.trace_id, self.span_id, True))

    def set_attributes(self, attributes: Mapping[str, object]) -> None:
        if self.ended:
            return
        accepted, dropped = filter_attributes(attributes)
        self.dropped_attributes += dropped
        for key, value in accepted.items():
            if key not in self.attributes and len(self.attributes) >= MAX_ATTRIBUTES:
                self.dropped_attributes += 1
            else:
                self.attributes[key] = value

    def add_event(self, name: str, attributes: Mapping[str, object] | None = None) -> None:
        if self.ended:
            return
        if len(self.events) >= MAX_EVENTS or not _name_allowed(name):
            self.dropped_events += 1
            return
        accepted, dropped = filter_attributes(attributes)
        event: dict[str, object] = {'timeUnixNano': str(time.time_ns()), 'name': name}
        if accepted:
            event['attributes'] = _key_values(accepted)
        if dropped:
            event['droppedAttributesCount'] = dropped
        self.events.append(event)

    def fail(self, error_type: str) -> None:
        if self.ended:
            return
        self.error = True
        self.set_attributes({'error.type': error_type})

    def end(self) -> None:
        if self.ended:
            return
        self.ended = True
        span: dict[str, object] = {
            'traceId': self.trace_id,
            'spanId': self.span_id,
            'name': self.name if _name_allowed(self.name) else 'bellis.unnamed',
            'kind': _KIND[self.kind],
            'startTimeUnixNano': str(self.start),
            'endTimeUnixNano': str(max(self.start, time.time_ns())),
        }
        if self.parent_span_id is not None:
            span['parentSpanId'] = self.parent_span_id
        if self.attributes:
            span['attributes'] = _key_values(self.attributes)
        if self.dropped_attributes:
            span['droppedAttributesCount'] = self.dropped_attributes
        if self.events:
            span['events'] = self.events
        if self.dropped_events:
            span['droppedEventsCount'] = self.dropped_events
        span['status'] = {'code': 2 if self.error else 0}
        self._exporter.put(span)


def _name_allowed(name: str) -> bool:
    return 1 <= len(name) <= 128 and _PRINTABLE_ASCII.match(name) is not None


class _RotatingFile:
    """`<目录>/<角色>-<UTC 时刻>-<序号>.jsonl`。

    按大小与时间轮转，同一角色只留最新的 maxFiles 个。
    """

    def __init__(self, config: SidecarTelemetry, role: str) -> None:
        self._config = config
        self._role = role
        self._seq = 0
        self._file: io.BufferedWriter | None = None
        self._path: Path | None = None
        self._bytes = 0
        self._opened = 0.0

    def write(self, chunk: str) -> None:
        data = chunk.encode('utf-8')
        if self._file is not None and (
            (self._bytes > 0 and self._bytes + len(data) > self._config.maxFileBytes)
            or (time.monotonic() - self._opened) * 1000 >= self._config.maxFileAgeMs
        ):
            self.close()
        handle = self._file if self._file is not None else self._open()
        try:
            handle.write(data)
            handle.flush()
        except OSError:
            # 写坏的文件不再续写：下一批换新文件。
            self.close()
            raise
        self._bytes += len(data)

    def close(self) -> None:
        handle = self._file
        self._file = None
        if handle is not None:
            with contextlib.suppress(OSError):
                handle.close()

    def _open(self) -> io.BufferedWriter:
        directory = Path(self._config.dir)
        directory.mkdir(parents=True, exist_ok=True)
        stamp = file_stamp(time.time_ns() // 1_000_000)
        while True:
            path = directory / f'{self._role}-{stamp}-{self._seq}.jsonl'
            self._seq += 1
            try:
                handle = path.open('xb')
            except FileExistsError:
                continue
            break
        self._file, self._path, self._bytes, self._opened = handle, path, 0, time.monotonic()
        self._prune(directory)
        return handle

    def _prune(self, directory: Path) -> None:
        own: list[tuple[str, int, Path]] = []
        for entry in directory.iterdir():
            match = _FILE.match(entry.name)
            if match is not None and match.group(1) == self._role:
                own.append((match.group(2), int(match.group(3)), entry))
        own.sort()
        for _, _, path in own[: max(0, len(own) - self._config.maxFiles)]:
            if path == self._path:
                continue
            with contextlib.suppress(OSError):
                path.unlink()


class _Exporter:
    """守护线程：有界队列，按间隔把攒下的 span 写成一行。"""

    def __init__(self, config: SidecarTelemetry, role: str, scope: str) -> None:
        self._config = config
        self._scope = scope
        self._file = _RotatingFile(config, role)
        pid = os.getpid()
        self._resource = _key_values(
            {
                'service.name': {'stringValue': f'bellis.{role}'},
                'service.instance.id': {'stringValue': f'{role}#{pid}'},
                'process.pid': {'intValue': str(pid)},
                'telemetry.sdk.name': {'stringValue': 'bellis'},
                'telemetry.sdk.language': {'stringValue': 'python'},
                'telemetry.sdk.version': {'stringValue': VERSION},
            }
        )
        self._queue: deque[dict[str, object]] = deque()
        self._condition = threading.Condition()
        self._closing = False
        self.dropped = 0
        self.write_failures = 0
        self.lost = 0
        self.lines = 0
        self._warned_full = False
        self._warned_write = False
        self._thread = threading.Thread(target=self._run, name='telemetry', daemon=True)
        self._thread.start()

    def put(self, span: dict[str, object]) -> None:
        with self._condition:
            if self._closing:
                return
            if len(self._queue) >= self._config.maxQueue:
                self._queue.popleft()
                self.dropped += 1
                if not self._warned_full:
                    self._warned_full = True
                    log.warning('遥测队列已满，丢弃最旧的记录')
            self._queue.append(span)

    def close(self, timeout: float) -> None:
        with self._condition:
            self._closing = True
            self._condition.notify()
        self._thread.join(timeout)

    def _run(self) -> None:
        interval = self._config.flushIntervalMs / 1000
        while True:
            with self._condition:
                if not self._closing:
                    self._condition.wait(interval)
                batch = list(self._queue)
                self._queue.clear()
                closing = self._closing
            if batch:
                self._write(batch)
            if closing:
                self._file.close()
                return

    def _write(self, batch: list[dict[str, object]]) -> None:
        line = json.dumps(
            {
                'resourceSpans': [
                    {
                        'resource': {'attributes': self._resource},
                        'scopeSpans': [{'scope': {'name': self._scope}, 'spans': batch}],
                    }
                ]
            },
            ensure_ascii=False,
            separators=(',', ':'),
        )
        try:
            self._file.write(f'{line}\n')
            self.lines += 1
        except OSError as error:
            self.write_failures += 1
            self.lost += len(batch)
            if not self._warned_write:
                self._warned_write = True
                log.warning('遥测写不进：%s', error.errno or type(error).__name__)


class _RecordingTelemetry(Telemetry):
    def __init__(self, config: SidecarTelemetry, role: str, scope: str) -> None:
        self.exporter = _Exporter(config, role, scope)

    def start_span(
        self,
        name: str,
        *,
        parent: str | None = None,
        kind: SpanKind = 'internal',
        attributes: Mapping[str, object] | None = None,
    ) -> Span:
        context = parse_traceparent(parent)
        span = _RecordingSpan(
            _exporter=self.exporter,
            name=name,
            kind=kind,
            trace_id=context.trace_id if context else _new_id(32),
            span_id=_new_id(16),
            parent_span_id=context.span_id if context else None,
        )
        if attributes:
            span.set_attributes(attributes)
        return span

    def close(self, timeout: float = 1.0) -> None:
        self.exporter.close(timeout)


def telemetry_from_env(env: Mapping[str, str], scope: str) -> Telemetry:
    """按宿主给的环境变量建遥测；没有、不合格或没有角色时返回空实现（只记一条日志）。"""
    raw = env.get(ENV_TELEMETRY)
    role = env.get(ENV_ROLE, '')
    if not raw:
        return NOOP_TELEMETRY
    if _ROLE.match(role) is None:
        log.warning('没有合格的通道角色，不写遥测')
        return NOOP_TELEMETRY
    try:
        config = SidecarTelemetry.model_validate_json(raw, strict=True)
    except ValidationError:
        log.warning('%s 不合格，不写遥测', ENV_TELEMETRY)
        return NOOP_TELEMETRY
    return _RecordingTelemetry(config, role, scope)
