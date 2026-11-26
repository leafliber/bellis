"""Strict stdlib dataclass JSON codec for realtime wire messages."""

from __future__ import annotations

import math
from dataclasses import dataclass, fields
from enum import StrEnum
from functools import cache
from types import UnionType
from typing import Annotated, Any, ClassVar, Self, cast, get_args, get_origin, get_type_hints


class ProtocolError(ValueError):
    """Raised when a protocol payload violates strict types, bounds, or unknown-field rules."""


@dataclass(frozen=True, slots=True)
class IntRange:
    low: int
    high: int


type U16 = Annotated[int, IntRange(0, 0xFFFF)]
type U32 = Annotated[int, IntRange(0, 0xFFFFFFFF)]
type U64 = Annotated[int, IntRange(0, 0xFFFFFFFFFFFFFFFF)]
type I32 = Annotated[int, IntRange(-(1 << 31), (1 << 31) - 1)]
type F64 = float


def _unwrap_alias(tp: Any) -> Any:
    while hasattr(tp, "__value__"):
        tp = tp.__value__
    return tp


@cache
def _hints(cls: type[Any]) -> dict[str, Any]:
    return get_type_hints(cls, include_extras=True)


def _encode(val: object) -> object:
    if isinstance(val, WireModel):
        return val.to_dict()
    if isinstance(val, StrEnum):
        return val.value
    if isinstance(val, tuple):
        return [_encode(x) for x in cast("tuple[object, ...]", val)]
    return val


def _decode(val: object, tp: Any, path: str) -> Any:
    tp = _unwrap_alias(tp)
    origin = get_origin(tp)
    if origin is Annotated:
        base, *meta = get_args(tp)
        out = _decode(val, base, path)
        for m in meta:
            if isinstance(m, IntRange) and not (m.low <= out <= m.high):
                raise ProtocolError(f"{path}: {out} outside [{m.low}, {m.high}]")
        return out
    if origin is UnionType:
        args = [_unwrap_alias(a) for a in get_args(tp)]
        if type(None) in args:
            if val is None:
                return None
            return _decode(val, next(a for a in args if a is not type(None)), path)
        if all(isinstance(a, type) and issubclass(a, TaggedModel) for a in args):
            return decode_tagged(val, tuple(args), path)
    if origin is tuple:
        elem = get_args(tp)[0]
        if not isinstance(val, list):
            raise ProtocolError(f"{path}: expected list")
        return tuple(_decode(x, elem, f"{path}[{i}]") for i, x in enumerate(cast("list[Any]", val)))
    if tp is bool:
        if not isinstance(val, bool):
            raise ProtocolError(f"{path}: expected bool")
        return val
    if tp is int:
        if isinstance(val, bool) or not isinstance(val, int):
            raise ProtocolError(f"{path}: expected int")
        return val
    if tp is float:
        if isinstance(val, bool) or not isinstance(val, int | float):
            raise ProtocolError(f"{path}: expected number")
        f = float(val)
        if not math.isfinite(f):
            raise ProtocolError(f"{path}: non-finite float")
        return f
    if tp is str:
        if not isinstance(val, str):
            raise ProtocolError(f"{path}: expected str")
        return val
    if isinstance(tp, type) and issubclass(tp, StrEnum):
        if not isinstance(val, str):
            raise ProtocolError(f"{path}: expected {tp.__name__} str")
        try:
            return tp(val)
        except ValueError as exc:
            raise ProtocolError(f"{path}: invalid {tp.__name__} {val!r}") from exc
    if isinstance(tp, type) and issubclass(tp, WireModel):
        return tp.from_dict(val, path)
    raise ProtocolError(f"{path}: unsupported schema type {tp!r}")


def decode_tagged(raw: object, variants: tuple[type[TaggedModel], ...], path: str) -> Any:
    if not isinstance(raw, dict):
        raise ProtocolError(f"{path}: expected object")
    obj = cast("dict[str, Any]", raw)
    tag = obj.get("type")
    if not isinstance(tag, str):
        raise ProtocolError(f"{path}.type: expected str")
    for cls in variants:
        if tag == cls.TAG:
            return cls.from_dict(obj, path)
    raise ProtocolError(f"{path}: unknown type tag {tag!r}")


class WireModel:
    """Strict closed-object dataclass codec (rejects missing/unknown keys and invalid ranges)."""

    def __post_init__(self) -> None:
        hints = _hints(type(self))
        for f in fields(cast("Any", self)):
            val = getattr(self, f.name)
            tp = _unwrap_alias(hints[f.name])
            if get_origin(tp) is Annotated:
                base, *meta = get_args(tp)
                if base is int and (isinstance(val, bool) or not isinstance(val, int)):
                    raise ProtocolError(f"{type(self).__name__}.{f.name}: expected int")
                for m in meta:
                    if isinstance(m, IntRange) and not (m.low <= val <= m.high):
                        raise ProtocolError(f"{type(self).__name__}.{f.name}: out of range")
            elif tp is float and (isinstance(val, bool) or not math.isfinite(float(val))):
                raise ProtocolError(f"{type(self).__name__}.{f.name}: expected finite float")

    def to_dict(self) -> dict[str, object]:
        return {f.name: _encode(getattr(self, f.name)) for f in fields(cast("Any", self))}

    @classmethod
    def from_dict(cls, raw: object, name: str | None = None) -> Self:
        label = cls.__name__ if name is None else name
        if not isinstance(raw, dict):
            raise ProtocolError(f"{label}: expected object")
        obj = cast("dict[str, Any]", raw)
        flds = fields(cast("Any", cls))
        expected = {f.name for f in flds}
        if obj.keys() != expected:
            raise ProtocolError(
                f"{label}: key mismatch (got={sorted(obj)}, exp={sorted(expected)})"
            )
        hints = _hints(cls)
        kwargs = {f.name: _decode(obj[f.name], hints[f.name], f"{label}.{f.name}") for f in flds}
        return cast("Self", cast("Any", cls)(**kwargs))


class TaggedModel(WireModel):
    TAG: ClassVar[str]

    def to_dict(self) -> dict[str, object]:
        return {"type": self.TAG, **super().to_dict()}

    @classmethod
    def from_dict(cls, raw: object, name: str | None = None) -> Self:
        label = cls.__name__ if name is None else name
        if not isinstance(raw, dict):
            raise ProtocolError(f"{label}: expected object")
        obj = cast("dict[str, Any]", raw)
        if obj.get("type") != cls.TAG:
            raise ProtocolError(f"{label}: expected type={cls.TAG!r}")
        return super().from_dict({k: v for k, v in obj.items() if k != "type"}, label)
