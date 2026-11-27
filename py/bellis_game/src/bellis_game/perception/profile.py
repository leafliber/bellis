"""Load the game declaration and translate its input allowlist to the wire protocol."""

import sys
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Literal, cast

import httpx2

from bellis_game.io.protocol import InputPolicy, NormRect, WindowTargetParams

from .frame import valid_norm_rect


class ProfileError(ValueError):
    """Invalid game declaration."""


def checked_base_url(base_url: str) -> str:
    try:
        url = httpx2.URL(base_url)
    except (TypeError, ValueError, httpx2.InvalidURL):
        raise ProfileError("invalid VLM URL") from None
    local = url.scheme == "http" and url.host in {"127.0.0.1", "localhost"}
    plain_host = url.host and not any(c in url.host for c in ("%", "\\"))
    if not plain_host or url.userinfo or url.query or url.fragment:
        raise ProfileError("invalid VLM endpoint")
    if not (local or url.scheme == "https"):
        raise ProfileError("invalid VLM endpoint")
    if url.port is not None and not 1 <= url.port <= 65535:
        raise ProfileError("invalid VLM port")
    return base_url


def timeout_seconds(value: object) -> float:
    if (type(value) is int or type(value) is float) and 0 < value <= sys.float_info.max:
        return float(value)
    raise ProfileError("expected a finite positive VLM timeout")


@dataclass(frozen=True, slots=True)
class VlmProfileConfig:
    base_url: str
    model: str
    reasoning_effort: str | None
    max_long_edge: int
    image_format: Literal["jpeg", "png"]
    jpeg_quality: int
    timeout_s: float
    cred_targets: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class GameProfile:
    game_id: str
    display_name: str
    window: WindowTargetParams
    expected_width: int
    expected_height: int
    key_scan_codes: Mapping[str, int]
    input_policy: InputPolicy
    vlm: VlmProfileConfig
    hold_key_names: frozenset[str] = frozenset()

    def scan_code_for(self, key_name: str) -> int | None:
        return self.key_scan_codes.get(key_name.casefold())

    def point_allowed(self, x: int, y: int, width: int, height: int) -> bool:
        if not all(type(v) is int for v in (x, y, width, height)) or not (
            0 <= x < width and 0 <= y < height
        ):
            return False
        nx, ny = x / width, y / height

        def contains(r: NormRect) -> bool:
            return r.left <= nx < r.right and r.top <= ny < r.bottom

        return any(map(contains, self.input_policy.click_regions)) and not any(
            map(contains, self.input_policy.forbidden_zones)
        )


def _table(value: object, required: str = "", optional: str = "") -> dict[str, object]:
    if not isinstance(value, dict):
        raise ProfileError("expected a TOML table")
    table = cast("dict[str, object]", value)
    if required:
        keys = set(required.split())
        if keys - table.keys() or table.keys() - keys - set(optional.split()):
            raise ProfileError(f"expected table fields {required} (optional: {optional})")
    return table


def _text(value: object) -> str:
    if not isinstance(value, str) or not value.strip() or "\0" in value:
        raise ProfileError("expected non-empty text")
    return value


def _int(value: object, maximum: int | None = None) -> int:
    if type(value) is not int or value < 1 or (maximum is not None and value > maximum):
        raise ProfileError("integer outside allowed range")
    return value


def _vlm(raw: object) -> VlmProfileConfig:
    v = _table(
        raw,
        "base_url model max_long_edge image_format jpeg_quality timeout_s cred_targets",
        optional="reasoning_effort",
    )
    effort = _text(v["reasoning_effort"]) if "reasoning_effort" in v else None
    fmt, targets = v["image_format"], v["cred_targets"]
    if fmt not in ("jpeg", "png"):
        raise ProfileError("invalid VLM image format")
    if not isinstance(targets, list):
        raise ProfileError("expected an array of credential targets")
    return VlmProfileConfig(
        checked_base_url(_text(v["base_url"])), _text(v["model"]), effort,
        _int(v["max_long_edge"]), fmt, _int(v["jpeg_quality"], 100),
        timeout_seconds(v["timeout_s"]), tuple(_text(s) for s in cast("list[object]", targets)),
    )  # fmt: skip


def _policy(raw: object) -> tuple[Mapping[str, int], frozenset[str], InputPolicy]:
    table = _table(
        raw,
        "keys click_buttons scroll press_duration_ms max_rate click_regions forbidden_zones",
        optional="hold_keys max_hold_ms",
    )
    keys = _table(table["keys"])
    codes = {_text(name).casefold(): _int(code, 0xFFFF) for name, code in keys.items()}
    if len(codes) != len(keys):
        raise ProfileError("ambiguous key names")
    raw_hold = table.get("hold_keys", [])
    if not isinstance(raw_hold, list):
        raise ProfileError("hold_keys must be an array of key names")
    hold_names: list[str] = []
    hold_codes: list[int] = []
    for item in cast("list[object]", raw_hold):
        name = _text(item).casefold()
        if name not in codes:
            raise ProfileError(f"hold key {name!r} is not declared in input.keys")
        if name not in hold_names:
            hold_names.append(name)
            hold_codes.append(codes[name])
    max_hold = table.get("max_hold_ms")
    if bool(hold_codes) != (max_hold is not None):
        raise ProfileError("max_hold_ms is required if and only if hold_keys is non-empty")
    max_hold_ms = _int(max_hold, 3000) if max_hold is not None else None
    if max_hold_ms is not None and max_hold_ms < 200:
        raise ProfileError("max_hold_ms must be at least 200")
    wire = {k: v for k, v in table.items() if k not in {"keys", "hold_keys", "max_hold_ms"}}
    policy = InputPolicy.from_dict(
        dict(
            wire,
            press_keys=list(codes.values()),
            hold_keys=hold_codes,
            hold_buttons=[],
            max_hold_ms=max_hold_ms,
        )
    )
    if not 1 <= policy.press_duration_ms <= 500 or policy.max_rate <= 0:
        raise ProfileError("invalid input duration or rate")
    if (policy.scroll or policy.click_buttons) and not policy.click_regions:
        raise ProfileError("pointer input requires click regions")
    if not all(map(valid_norm_rect, (*policy.click_regions, *policy.forbidden_zones))):
        raise ProfileError("invalid input rectangle")
    return MappingProxyType(codes), frozenset(hold_names), policy


def load_game_profile(path: Path | str) -> GameProfile:
    try:
        with Path(path).open("rb") as f:
            root = _table(tomllib.load(f), "game_id display_name window display vlm input")
        win = _table(root["window"], "process_name", "window_class title")
        window = WindowTargetParams(**{k: _text(v) for k, v in win.items()})
        display = _table(root["display"], "expected_width expected_height")
        codes, hold_names, policy = _policy(root["input"])
        return GameProfile(
            _text(root["game_id"]), _text(root["display_name"]), window,
            _int(display["expected_width"]), _int(display["expected_height"]),
            codes, policy, _vlm(root["vlm"]), hold_names,
        )  # fmt: skip
    except ProfileError:
        raise
    except (ValueError, OSError, OverflowError) as exc:
        raise ProfileError("could not read or decode game profile") from exc
